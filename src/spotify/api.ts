import { t } from '@/i18n';

import { getAccessToken } from './auth';

const API_BASE = 'https://api.spotify.com/v1';

/** Retries for 5xx responses and network failures/timeouts. */
const MAX_RETRIES = 4;
/** How many 429s in a row a single request tolerates before giving up. */
const MAX_RATE_LIMIT_RETRIES = 6;
/** Longest Retry-After we are willing to sit through; longer waits abort the sync with a message. */
const MAX_RATE_LIMIT_WAIT_S = 120;
/** A request that has not answered after this long is aborted and retried. */
const REQUEST_TIMEOUT_MS = 20_000;

export class SpotifyApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public reason?: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

/** Spotify asked us to wait longer than we are willing to (Development Mode quota/rate limit). */
export class RateLimitError extends Error {
  constructor(public retryAfterSeconds: number) {
    const minutes = Math.ceil(retryAfterSeconds / 60);
    super(
      minutes >= 120
        ? t('errors.rateLimitHours', { count: Math.round(minutes / 60) })
        : t('errors.rateLimitMinutes', { count: minutes }),
    );
    this.name = 'RateLimitError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- shared rate-limit gate
//
// When Spotify answers 429 every in-flight and future request has to back off, not just the one
// that got the 429 — otherwise the parallel workers keep hammering the API and extend the penalty.

let pausedUntil = 0;
let rateLimitListener: ((waitSeconds: number) => void) | null = null;

/** Called whenever requests are paused because of a 429 (used to show the wait in the UI). */
export function setRateLimitListener(listener: ((waitSeconds: number) => void) | null) {
  rateLimitListener = listener;
}

/**
 * Minimum spacing between request starts (≈120 requests per 30 s window at most). Development Mode
 * apps that burst past their limit can be locked out for up to 24 h, so a steady pace beats speed.
 */
const MIN_REQUEST_INTERVAL_MS = 250;
let nextRequestSlot = 0;

async function waitForRateLimitGate() {
  for (;;) {
    const now = Date.now();
    if (now < pausedUntil) {
      await sleep(pausedUntil - now);
      continue;
    }
    if (now < nextRequestSlot) {
      await sleep(nextRequestSlot - now);
      continue;
    }
    nextRequestSlot = now + MIN_REQUEST_INTERVAL_MS;
    return;
  }
}

function parseRetryAfterSeconds(res: Response, fallback: number): number {
  const value = Number(res.headers.get('Retry-After'));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Authenticated request to the Spotify Web API.
 * - 429: pauses *all* requests for Retry-After seconds (or aborts with RateLimitError if that is too long)
 * - 5xx / network error / timeout: retries with exponential backoff
 * - 401: refreshes the access token once
 * Returns null for empty (204) responses.
 */
export async function spotifyFetch<T>(pathOrUrl: string, init: RequestInit = {}): Promise<T | null> {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const endpoint = `${init.method ?? 'GET'} ${url.replace(API_BASE, '')}`;
  let refreshed = false;
  let failures = 0;
  let rateLimited = 0;

  for (;;) {
    await waitForRateLimitGate();
    const token = await getAccessToken({ forceRefresh: refreshed });
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      if (++failures > MAX_RETRIES) {
        throw new Error(t('errors.network', { endpoint, message: (e as Error).message }));
      }
      await sleep(1000 * 2 ** failures);
      continue;
    }

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      continue;
    }
    if (res.status === 429) {
      const wait = parseRetryAfterSeconds(res, 5 * 2 ** rateLimited);
      if (wait > MAX_RATE_LIMIT_WAIT_S || ++rateLimited > MAX_RATE_LIMIT_RETRIES) {
        throw new RateLimitError(wait);
      }
      pausedUntil = Math.max(pausedUntil, Date.now() + wait * 1000);
      rateLimitListener?.(wait);
      continue;
    }
    if (res.status >= 500 && ++failures <= MAX_RETRIES) {
      await sleep(1000 * 2 ** failures);
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      let message = t('errors.api', { status: res.status, endpoint });
      let reason: string | undefined;
      try {
        const body = JSON.parse(text) as { error?: { message?: string; reason?: string } };
        if (body.error?.message) message = `${message}: ${body.error.message}`;
        reason = body.error?.reason;
      } catch {
        // not JSON
      }
      throw new SpotifyApiError(res.status, message, reason);
    }
    return parseSuccessBody<T>(init.method ?? 'GET', text);
  }
}

/**
 * Some write endpoints (notably the player commands) answer 2xx with a body that is not JSON. Their
 * callers do not use the body, so for non-GET requests that is treated as "no content" instead of
 * failing an action that actually worked.
 */
function parseSuccessBody<T>(method: string, text: string): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    // Reads need their data, so a broken body there is still an error.
    if (method === 'GET') throw e;
    return null;
  }
}

// ---------------------------------------------------------------- types (only the fields we use)

type Image = { url: string; width: number | null; height: number | null };

/** `genres` is deprecated by Spotify and may be missing or empty for Development Mode apps. */
export type SpotifyArtist = { id: string; name: string; images?: Image[]; genres?: string[] };

export type SpotifyAlbum = {
  id: string;
  name: string;
  album_type: string;
  release_date: string;
  total_tracks: number;
  images: Image[];
};

export type SpotifyTrack = {
  id: string | null;
  name: string;
  uri: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
  is_playable?: boolean;
  is_local?: boolean;
  artists: { id: string; name: string }[];
};

type Paging<T> = { items: T[]; next: string | null };

/** Picks the smallest image that is at least `minSize` px wide (Spotify sorts images largest first). */
export function pickImage(images: Image[] | undefined, minSize = 160): string | null {
  if (!images?.length) return null;
  const big = images.filter((i) => (i.width ?? 0) >= minSize);
  return (big.length ? big[big.length - 1] : images[0]).url;
}

// ---------------------------------------------------------------- endpoints

async function getAllPages<T>(firstUrl: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = firstUrl;
  while (next) {
    const page: Paging<T> | null = await spotifyFetch<Paging<T>>(next);
    if (!page) break;
    items.push(...page.items);
    next = page.next;
  }
  return items;
}

export async function getFollowedArtists(): Promise<SpotifyArtist[]> {
  const artists: SpotifyArtist[] = [];
  let next: string | null = '/me/following?type=artist&limit=50';
  while (next) {
    const res: { artists: Paging<SpotifyArtist> } | null = await spotifyFetch(next);
    if (!res) break;
    artists.push(...res.artists.items);
    next = res.artists.next;
  }
  return artists;
}

/** Spotify's documented maximum page size for this endpoint (larger values are rejected with 400). */
const ARTIST_ALBUMS_PAGE_SIZE = 10;

/** Albums, EPs and singles of an artist (EPs are reported as album_type "single"). */
export function getArtistAlbums(artistId: string): Promise<SpotifyAlbum[]> {
  return getAllPages<SpotifyAlbum>(
    `/artists/${artistId}/albums?include_groups=album,single&market=from_token&limit=${ARTIST_ALBUMS_PAGE_SIZE}`,
  );
}

/** Artists matching `query` in Spotify's search, best match first (at most 10 for Development Mode apps). */
export async function searchArtists(query: string, limit = 5): Promise<SpotifyArtist[]> {
  const params = new URLSearchParams({ q: query, type: 'artist', limit: String(limit) });
  const res = await spotifyFetch<{ artists: Paging<SpotifyArtist> }>(`/search?${params}`);
  return res?.artists.items ?? [];
}

/**
 * Follows an artist for the logged-in user. Spotify replaced "Follow Artists" (PUT /me/following) with
 * "Save Items to Library" in 2026; an artist is saved by its URI.
 */
export async function followArtist(artistId: string): Promise<void> {
  const uris = encodeURIComponent(`spotify:artist:${artistId}`);
  await spotifyFetch(`/me/library?uris=${uris}`, { method: 'PUT' });
}

export async function getAlbumTracks(albumId: string): Promise<SpotifyTrack[]> {
  const tracks = await getAllPages<SpotifyTrack>(`/albums/${albumId}/tracks?market=from_token&limit=50`);
  return tracks.filter((t) => t.id && !t.is_local && t.is_playable !== false);
}

// ---------------------------------------------------------------- playlists & player

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Max items Spotify accepts in one "replace playlist items" request. */
export const PLAYLIST_REPLACE_LIMIT = 100;

/** Creates a playlist owned by the current user. */
export async function createPlaylist(name: string, description: string): Promise<string> {
  const res = await spotifyFetch<{ id: string }>('/me/playlists', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, description, public: false }),
  });
  if (!res?.id) throw new Error(t('errors.noPlaylistReturned'));
  return res.id;
}

/** Whether the playlist is in the user's library (a "deleted" playlist is only unfollowed, not gone). */
export async function isPlaylistInLibrary(playlistId: string): Promise<boolean> {
  const uri = encodeURIComponent(`spotify:playlist:${playlistId}`);
  const res = await spotifyFetch<boolean[]>(`/me/library/contains?uris=${uri}`);
  return res?.[0] === true;
}

/** Replaces all items of a playlist with `uris` (at most PLAYLIST_REPLACE_LIMIT). */
export async function replacePlaylistItems(playlistId: string, uris: string[]): Promise<void> {
  if (uris.length > PLAYLIST_REPLACE_LIMIT) {
    throw new Error(t('errors.tooManySongs', { count: PLAYLIST_REPLACE_LIMIT }));
  }
  await spotifyFetch(`/playlists/${playlistId}/items`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ uris }),
  });
}

/** Starts a playlist from its first song on the active device (Premium only). */
export async function playPlaylistFromStart(playlistId: string): Promise<void> {
  await spotifyFetch('/me/player/play', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ context_uri: `spotify:playlist:${playlistId}`, offset: { position: 0 } }),
  });
}

/** Turns Spotify's own shuffle on/off for the active device (Premium only). */
export async function setPlaybackShuffle(on: boolean): Promise<void> {
  await spotifyFetch(`/me/player/shuffle?state=${on}`, { method: 'PUT' });
}
