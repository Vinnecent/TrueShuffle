import Constants from 'expo-constants';
import type { SQLiteDatabase } from 'expo-sqlite';

import { getArtistsDueForGenres, saveMusicBrainzArtist } from '@/db/queries';
import { notifyGenresChanged } from '@/genres/events';
import { t } from '@/i18n';

/**
 * Artist genres from MusicBrainz (https://musicbrainz.org/doc/MusicBrainz_API): no account or key, but it asks
 * for at most one request per second per IP and a User-Agent naming the app and a contact. Two requests per
 * new artist (its MusicBrainz ID through its Spotify link, then its genres), one when the ID is known.
 */
const API_BASE = 'https://musicbrainz.org/ws/2';
const USER_AGENT = `TrueShuffle/${Constants.expoConfig?.version ?? 'dev'} ( https://github.com/Vinnecent/TrueShuffle )`;

/** Time between two requests: MusicBrainz allows one per second; 1.5 s stays well clear of it. */
const REQUEST_INTERVAL_MS = 1500;
/** "Busy" (503) answers are retried with growing pauses (5, 10, 20, 40 s) before giving up. */
const BUSY_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20_000;
/** Lookups older than this are refreshed by the next genre sync (genres on MusicBrainz change slowly). */
export const GENRE_REFRESH_AFTER_MS = 90 * 24 * 60 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;

/** GET with the pacing above; null for 404 (MusicBrainz does not know it). */
async function musicBrainzFetch<T>(path: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    const wait = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      if (attempt >= BUSY_RETRIES) throw new Error(t('genres.networkError', { message: (e as Error).message }));
      await sleep(5000 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return null;
    if (res.status === 503 || res.status === 429) {
      if (attempt >= BUSY_RETRIES) throw new Error(t('genres.busy'));
      await sleep(5000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(t('genres.apiError', { status: res.status }));
    return (await res.json()) as T;
  }
}

/** The MusicBrainz ID of a Spotify artist, through the Spotify link stored on MusicBrainz; null if none. */
async function lookupMusicBrainzId(spotifyArtistId: string): Promise<string | null> {
  const resource = encodeURIComponent(`https://open.spotify.com/artist/${spotifyArtistId}`);
  const res = await musicBrainzFetch<{ relations?: { artist?: { id: string } }[] }>(
    `url?resource=${resource}&inc=artist-rels&fmt=json`,
  );
  return res?.relations?.find((r) => r.artist)?.artist?.id ?? null;
}

async function getMusicBrainzGenres(mbid: string): Promise<string[]> {
  const res = await musicBrainzFetch<{ genres?: { name: string }[] }>(`artist/${mbid}?inc=genres&fmt=json`);
  return res?.genres?.map((g) => g.name) ?? [];
}

export type GenreSyncProgress = { done: number; total: number };
export type GenreSyncResult = { checked: number; found: number };

let running = false;

export const isGenreSyncRunning = () => running;

/**
 * Looks up the genres of every included artist not looked up yet (or not for 90 days). Each artist is saved
 * as soon as it is done, so an interrupted sync continues where it stopped.
 */
export async function syncGenres(
  db: SQLiteDatabase,
  onProgress: (progress: GenreSyncProgress) => void,
): Promise<GenreSyncResult> {
  if (running) throw new Error(t('genres.alreadyRunning'));
  running = true;
  try {
    const due = await getArtistsDueForGenres(db, new Date(Date.now() - GENRE_REFRESH_AFTER_MS).toISOString());
    let found = 0;
    onProgress({ done: 0, total: due.length });
    for (let i = 0; i < due.length; i++) {
      const artist = due[i];
      const mbid = artist.mbid ?? (await lookupMusicBrainzId(artist.id));
      const genres = mbid ? await getMusicBrainzGenres(mbid) : [];
      await saveMusicBrainzArtist(db, artist.id, mbid, genres);
      if (genres.length > 0) found++;
      // The first genres make the Genres tab appear; afterwards an update every 10 artists is enough.
      if ((genres.length > 0 && found === 1) || i % 10 === 9) notifyGenresChanged();
      onProgress({ done: i + 1, total: due.length });
    }
    notifyGenresChanged();
    return { checked: due.length, found };
  } finally {
    running = false;
  }
}
