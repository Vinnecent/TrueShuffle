import type { SQLiteDatabase } from 'expo-sqlite';

import { pickRandomFromGroups, pickRandomUnique } from '@/lib/shuffle';

export const MAX_QUEUE_SIZE = 75;

export type ArtistRow = {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
  track_count: number;
  /** 1 if the artist is excluded from the shuffle. */
  excluded: number;
};

export type AlbumRow = {
  id: string;
  name: string;
  album_type: string;
  release_date: string | null;
  total_tracks: number;
  image_url: string | null;
};

export type TrackRow = {
  id: string;
  album_id: string;
  name: string;
  uri: string;
  artists: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
};

export type QueueRow = {
  position: number;
  track_id: string;
  name: string;
  uri: string;
  artists: string;
  duration_ms: number;
  album_name: string;
  image_url: string | null;
};

/** An artist counts as up to date when its releases were fetched within this time (new releases, changes). */
export const ARTIST_REFRESH_AFTER_MS = 7 * 24 * 60 * 60_000;

export type LibraryStats = {
  /** Followed artists, including excluded ones. */
  artists: number;
  /** Artists excluded from the shuffle; they are not synced either. */
  excludedArtists: number;
  /** Included artists scanned within ARTIST_REFRESH_AFTER_MS. */
  freshArtists: number;
  /** Included artists whose releases were never fetched. */
  unscannedArtists: number;
  albums: number;
  tracks: number;
  lastSync: string | null;
};

// ---------------------------------------------------------------- reads

export function getArtists(db: SQLiteDatabase): Promise<ArtistRow[]> {
  return db.getAllAsync<ArtistRow>(`
    SELECT ar.id, ar.name, ar.image_url,
           COUNT(DISTINCT aa.album_id) AS album_count,
           COUNT(t.id)                 AS track_count,
           EXISTS (SELECT 1 FROM excluded_artists e WHERE e.artist_id = ar.id) AS excluded
    FROM artists ar
    LEFT JOIN artist_albums aa ON aa.artist_id = ar.id
    LEFT JOIN tracks t         ON t.album_id = aa.album_id
    GROUP BY ar.id
    ORDER BY ar.name COLLATE NOCASE
  `);
}

export async function getArtist(db: SQLiteDatabase, artistId: string) {
  const row = await db.getFirstAsync<{ id: string; name: string; image_url: string | null; excluded: number }>(
    `SELECT id, name, image_url,
            EXISTS (SELECT 1 FROM excluded_artists e WHERE e.artist_id = artists.id) AS excluded
     FROM artists WHERE id = ?`,
    artistId,
  );
  return row ? { ...row, excluded: row.excluded === 1 } : null;
}

/**
 * Songs the shuffle may pick: those on a release of at least one followed artist that is not excluded.
 * A release shared by an excluded and an included artist therefore stays in the shuffle.
 */
const SHUFFLE_TRACKS_WHERE = `
  EXISTS (
    SELECT 1 FROM artist_albums aa
    WHERE aa.album_id = t.album_id
      AND aa.artist_id NOT IN (SELECT artist_id FROM excluded_artists)
  )`;

/** Filters for the shuffle, chosen on the Queue tab. */
export type ShuffleFilters = {
  /** Skip songs with "acoustic" in the title. */
  excludeAcoustic: boolean;
  /** Skip songs with "remix" in the title. */
  excludeRemix: boolean;
  /** Skip live recordings ("Song - Live", "Song (Live at …)", "Song [Live]"). */
  excludeLive: boolean;
  /** Skip intros: the first song of a multi-track release when it is shorter than 1:30. */
  excludeIntro: boolean;
  /** Skip songs with "instrumental" in the title. */
  excludeInstrumental: boolean;
  /**
   * Skip albums that have a deluxe version (same artist, same name plus "Deluxe") containing all of
   * their songs, so those songs only come from the deluxe version.
   */
  preferDeluxe: boolean;
};

export const DEFAULT_SHUFFLE_FILTERS: ShuffleFilters = {
  excludeAcoustic: false,
  excludeRemix: false,
  excludeLive: false,
  excludeIntro: false,
  excludeInstrumental: false,
  preferDeluxe: false,
};

/** Meta keys of the filters; Clear library keeps every `filter_` key (they are preferences, not synced data). */
const FILTER_KEYS: Record<keyof ShuffleFilters, string> = {
  excludeAcoustic: 'filter_exclude_acoustic',
  excludeRemix: 'filter_exclude_remix',
  excludeLive: 'filter_exclude_live',
  excludeIntro: 'filter_exclude_intro',
  excludeInstrumental: 'filter_exclude_instrumental',
  preferDeluxe: 'filter_prefer_deluxe',
};

/** Intros are at most this long (1:30). */
const INTRO_MAX_MS = 90_000;

type ShuffleCandidate = {
  id: string;
  album_id: string;
  name: string;
  artists: string;
  disc_number: number;
  track_number: number;
  duration_ms: number;
  album_total_tracks: number;
};

const LIVE_PATTERN =
  // "live" as a whole word in the version part of the title: after " - " or inside ( ) / [ ].
  // Keeps titles like "Alive", "Olive" or "Live Forever".
  /\s[-–—]\s.*\blive\b|[([][^)\]]*\blive\b/i;

/** Data a filter needs beyond the song itself. */
type FilterContext = {
  /** Albums fully contained in a deluxe version (only loaded when preferDeluxe is on). */
  coveredByDeluxe: Set<string>;
};

/** What each filter removes; titles are matched case-insensitively. */
const FILTER_TESTS: Record<keyof ShuffleFilters, (t: ShuffleCandidate, ctx: FilterContext) => boolean> = {
  excludeAcoustic: (t) => /acoustic/i.test(t.name),
  excludeRemix: (t) => /remix/i.test(t.name),
  excludeLive: (t) => LIVE_PATTERN.test(t.name),
  excludeIntro: (t) =>
    t.disc_number === 1 && t.track_number === 1 && t.duration_ms < INTRO_MAX_MS && t.album_total_tracks > 1,
  excludeInstrumental: (t) => /instrumental/i.test(t.name),
  preferDeluxe: (t, ctx) => ctx.coveredByDeluxe.has(t.album_id),
};

const DELUXE_PATTERN = /deluxe/i;

/**
 * The album name without its deluxe part, lower-cased: "Reborn (Deluxe)", "Echo [Deluxe Version]",
 * "Heritage: Absolute Deluxe Edition" and "Self Inflicted Deluxe Edition" give "reborn", "echo", "heritage"
 * and "self inflicted".
 */
function deluxeBaseName(name: string): string {
  return name
    .replace(/\s*[([][^)\]]*deluxe[^)\]]*[)\]]/gi, '')
    .replace(/\s*[-–—:]\s*[^-–—:]*deluxe.*$/i, '')
    .replace(/\s+deluxe(\s+(edition|version|reissue))?\s*$/i, '')
    .trim()
    .toLowerCase();
}

/**
 * A song title for comparing two releases: lower-cased, typographic apostrophes made plain and featured
 * artists left out, so "Song ft. A" matches "Song - with A" and "Song (feat. A)".
 */
function songTitleKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s*[([](feat\.?|ft\.?|with)\s[^)\]]*[)\]]/g, '')
    .replace(/\s+-\s+(feat\.?|ft\.?|with)\s.*$/, '')
    .replace(/\s+(feat\.?|ft\.?)\s.*$/, '')
    .trim();
}

/**
 * Albums whose songs are all on a deluxe version by the same artist, e.g. "Reborn" when "Reborn (Deluxe)"
 * has every song of it. An album missing even one of its songs from the deluxe version is not included.
 */
/** Releases of artists that have at least one release with "deluxe" in its name (LIKE ignores case). */
const DELUXE_ARTIST_ALBUMS = `
  SELECT aa.album_id FROM artist_albums aa
  WHERE aa.artist_id IN (
    SELECT aa2.artist_id FROM artist_albums aa2 JOIN albums d ON d.id = aa2.album_id WHERE d.name LIKE '%deluxe%'
  )`;

async function getAlbumsCoveredByDeluxe(db: SQLiteDatabase): Promise<Set<string>> {
  const [albums, tracks] = await Promise.all([
    db.getAllAsync<{ artist_id: string; album_id: string; name: string }>(
      `SELECT aa.artist_id, aa.album_id, al.name
       FROM artist_albums aa JOIN albums al ON al.id = aa.album_id
       WHERE aa.album_id IN (${DELUXE_ARTIST_ALBUMS})`,
    ),
    db.getAllAsync<{ album_id: string; name: string }>(
      `SELECT album_id, name FROM tracks
       WHERE album_id IN (${DELUXE_ARTIST_ALBUMS})`,
    ),
  ]);
  const songsByAlbum = new Map<string, Set<string>>();
  for (const t of tracks) {
    const set = songsByAlbum.get(t.album_id) ?? new Set<string>();
    set.add(songTitleKey(t.name));
    songsByAlbum.set(t.album_id, set);
  }
  const albumsByArtist = new Map<string, { id: string; name: string }[]>();
  for (const a of albums) {
    const list = albumsByArtist.get(a.artist_id) ?? [];
    list.push({ id: a.album_id, name: a.name });
    albumsByArtist.set(a.artist_id, list);
  }

  const covered = new Set<string>();
  for (const list of albumsByArtist.values()) {
    for (const deluxe of list) {
      if (!DELUXE_PATTERN.test(deluxe.name)) continue;
      const base = deluxeBaseName(deluxe.name);
      const deluxeSongs = songsByAlbum.get(deluxe.id);
      if (!base || !deluxeSongs) continue;
      for (const regular of list) {
        if (regular.id === deluxe.id || DELUXE_PATTERN.test(regular.name)) continue;
        if (regular.name.trim().toLowerCase() !== base) continue;
        const songs = songsByAlbum.get(regular.id);
        if (songs && [...songs].every((song) => deluxeSongs.has(song))) covered.add(regular.id);
      }
    }
  }
  return covered;
}

/** What the enabled filters need to test songs; loads only what they use. */
async function loadFilterContext(db: SQLiteDatabase, filters: ShuffleFilters): Promise<FilterContext> {
  return { coveredByDeluxe: filters.preferDeluxe ? await getAlbumsCoveredByDeluxe(db) : new Set() };
}

export async function getShuffleFilters(db: SQLiteDatabase): Promise<ShuffleFilters> {
  const rows = await db.getAllAsync<{ key: string; value: string | null }>(
    `SELECT key, value FROM meta WHERE key LIKE 'filter!_%' ESCAPE '!'`,
  );
  const filters = { ...DEFAULT_SHUFFLE_FILTERS };
  for (const key of Object.keys(FILTER_KEYS) as (keyof ShuffleFilters)[]) {
    filters[key] = rows.some((r) => r.key === FILTER_KEYS[key] && r.value === '1');
  }
  return filters;
}

export async function setShuffleFilter(db: SQLiteDatabase, filter: keyof ShuffleFilters, enabled: boolean) {
  await setMeta(db, FILTER_KEYS[filter], enabled ? '1' : '0');
}

/**
 * How the shuffle weighs artists against each other:
 * - `song`: every song has the same chance, so artists with many songs come up more often;
 * - `balanced`: an artist's chance grows with the square root of their song count;
 * - `artist`: every artist has the same chance, whatever their song count.
 */
export type ArtistWeighting = 'song' | 'balanced' | 'artist';

export const DEFAULT_ARTIST_WEIGHTING: ArtistWeighting = 'song';

/** Stored with the filters (a `filter_` key), so Clear library keeps it. */
const ARTIST_WEIGHTING_KEY = 'filter_artist_weighting';

export async function getArtistWeighting(db: SQLiteDatabase): Promise<ArtistWeighting> {
  const value = await getMeta(db, ARTIST_WEIGHTING_KEY);
  return value === 'balanced' || value === 'artist' ? value : DEFAULT_ARTIST_WEIGHTING;
}

export async function setArtistWeighting(db: SQLiteDatabase, weighting: ArtistWeighting) {
  await setMeta(db, ARTIST_WEIGHTING_KEY, weighting);
}

/** Whether a song passes the enabled filters. */
function passesShuffleFilters(track: ShuffleCandidate, filters: ShuffleFilters, ctx: FilterContext): boolean {
  for (const key of Object.keys(FILTER_TESTS) as (keyof ShuffleFilters)[]) {
    if (filters[key] && FILTER_TESTS[key](track, ctx)) return false;
  }
  return true;
}

/**
 * Songs on one artist's releases (the same songs as their artist page), with the filters applied,
 * whether or not the artist is excluded from the normal shuffle.
 */
async function getArtistShuffleCandidates(
  db: SQLiteDatabase,
  filters: ShuffleFilters,
  artistId: string,
): Promise<ShuffleCandidate[]> {
  const rows = await db.getAllAsync<ShuffleCandidate>(
    `SELECT t.id, t.album_id, t.name, t.artists, t.disc_number, t.track_number, t.duration_ms,
            al.total_tracks AS album_total_tracks
     FROM tracks t
     JOIN albums al ON al.id = t.album_id
     WHERE t.album_id IN (SELECT album_id FROM artist_albums WHERE artist_id = ?)`,
    artistId,
  );
  const ctx = await loadFilterContext(db, filters);
  return rows.filter((t) => passesShuffleFilters(t, filters, ctx));
}

/** What the normal shuffle draws from, with excluded artists left out and the filters applied. */
type ShuffleCandidates = {
  /** Every song once. */
  songs: ShuffleCandidate[];
  /** The songs grouped by followed artist; a song on a release shared by several artists is in each group. */
  byArtist: ShuffleCandidate[][];
};

/**
 * Changes whenever the shuffle candidates can have changed: songs, releases or artist links added or
 * removed, an artist (re)synced (which also covers renamed songs), or the excluded artists changed.
 * Cheap compared with loading every song.
 */
const LIBRARY_SIGNATURE_SQL = `
  SELECT (SELECT COUNT(*) FROM tracks) || '|' || (SELECT COUNT(*) FROM albums) || '|' ||
         (SELECT COUNT(*) FROM artist_albums) || '|' || IFNULL((SELECT MAX(albums_synced_at) FROM artists), '') || '|' ||
         IFNULL((SELECT group_concat(artist_id) FROM (SELECT artist_id FROM excluded_artists ORDER BY artist_id)), '')
    AS signature`;

/**
 * The last loaded candidates. Loading every song takes a noticeable moment on a phone, so they are kept
 * and reused (e.g. by Shuffle after the Queue tab counted them) while the library and filters stay the same.
 */
let candidateCache: { key: string; candidates: ShuffleCandidates } | null = null;

/** Drops the kept shuffle candidates, for changes the library signature may not show (import, clear). */
export function invalidateShuffleCandidates(): void {
  candidateCache = null;
}

async function getShuffleCandidates(db: SQLiteDatabase, filters: ShuffleFilters): Promise<ShuffleCandidates> {
  const row = await db.getFirstAsync<{ signature: string }>(LIBRARY_SIGNATURE_SQL);
  const key = `${row?.signature ?? ''}#${JSON.stringify(filters)}`;
  if (candidateCache?.key === key) return candidateCache.candidates;

  const [rows, ctx] = await Promise.all([
    db.getAllAsync<ShuffleCandidate & { artist_id: string }>(
      `SELECT t.id, t.album_id, t.name, t.artists, t.disc_number, t.track_number, t.duration_ms,
              al.total_tracks AS album_total_tracks, aa.artist_id
       FROM tracks t
       JOIN albums al ON al.id = t.album_id
       JOIN artist_albums aa ON aa.album_id = t.album_id
       WHERE aa.artist_id NOT IN (SELECT artist_id FROM excluded_artists)`,
    ),
    loadFilterContext(db, filters),
  ]);
  const songs = new Map<string, ShuffleCandidate>();
  const byArtist = new Map<string, ShuffleCandidate[]>();
  for (const row of rows) {
    if (!passesShuffleFilters(row, filters, ctx)) continue;
    if (!songs.has(row.id)) songs.set(row.id, row);
    const list = byArtist.get(row.artist_id);
    if (list) list.push(row);
    else byArtist.set(row.artist_id, [row]);
  }
  const candidates = { songs: [...songs.values()], byArtist: [...byArtist.values()] };
  candidateCache = { key, candidates };
  return candidates;
}

/** Number of stored songs the shuffle can draw from (excluded artists and filters applied). */
export async function countShuffleTracks(db: SQLiteDatabase, filters: ShuffleFilters): Promise<number> {
  return (await getShuffleCandidates(db, filters)).songs.length;
}

export type AlbumWithTracks = AlbumRow & { tracks: TrackRow[] };

/** All albums/EPs/singles of an artist (newest first), each with its tracks. */
export async function getArtistDiscography(
  db: SQLiteDatabase,
  artistId: string,
): Promise<AlbumWithTracks[]> {
  const albums = await db.getAllAsync<AlbumRow>(
    `SELECT al.* FROM albums al
     JOIN artist_albums aa ON aa.album_id = al.id
     WHERE aa.artist_id = ?
     ORDER BY al.release_date DESC, al.name COLLATE NOCASE`,
    artistId,
  );
  const tracks = await db.getAllAsync<TrackRow>(
    `SELECT t.* FROM tracks t
     JOIN artist_albums aa ON aa.album_id = t.album_id
     WHERE aa.artist_id = ?
     ORDER BY t.disc_number, t.track_number`,
    artistId,
  );
  const byAlbum = new Map<string, TrackRow[]>();
  for (const t of tracks) {
    const list = byAlbum.get(t.album_id);
    if (list) list.push(t);
    else byAlbum.set(t.album_id, [t]);
  }
  return albums.map((a) => ({ ...a, tracks: byAlbum.get(a.id) ?? [] }));
}

export function getQueue(db: SQLiteDatabase): Promise<QueueRow[]> {
  return db.getAllAsync<QueueRow>(`
    SELECT q.position, q.track_id, t.name, t.uri, t.artists, t.duration_ms,
           al.name AS album_name, al.image_url
    FROM queue q
    JOIN tracks t  ON t.id = q.track_id
    JOIN albums al ON al.id = t.album_id
    ORDER BY q.position
  `);
}

/** A stored song looked up by its Spotify URI ("spotify:track:…"), with its album cover. */
export function getTrackByUri(
  db: SQLiteDatabase,
  uri: string,
): Promise<{ duration_ms: number; image_url: string | null } | null> {
  return db.getFirstAsync(
    `SELECT t.duration_ms, al.image_url
     FROM tracks t
     JOIN albums al ON al.id = t.album_id
     WHERE t.uri = ?
     LIMIT 1`,
    uri,
  );
}

export async function getLibraryStats(db: SQLiteDatabase): Promise<LibraryStats> {
  const freshSince = new Date(Date.now() - ARTIST_REFRESH_AFTER_MS).toISOString();
  const row = await db.getFirstAsync<{
    artists: number;
    excluded: number;
    fresh: number;
    unscanned: number;
    albums: number;
    tracks: number;
  }>(
    `SELECT (SELECT COUNT(*) FROM artists) AS artists,
            (SELECT COUNT(*) FROM excluded_artists) AS excluded,
            (SELECT COUNT(*) FROM artists
              WHERE id NOT IN (SELECT artist_id FROM excluded_artists) AND albums_synced_at >= ?) AS fresh,
            (SELECT COUNT(*) FROM artists
              WHERE id NOT IN (SELECT artist_id FROM excluded_artists) AND albums_synced_at IS NULL) AS unscanned,
            (SELECT COUNT(*) FROM albums)  AS albums,
            (SELECT COUNT(*) FROM tracks)  AS tracks`,
    freshSince,
  );
  const lastSync = await getMeta(db, 'last_sync');
  return {
    artists: row?.artists ?? 0,
    excludedArtists: row?.excluded ?? 0,
    freshArtists: row?.fresh ?? 0,
    unscannedArtists: row?.unscanned ?? 0,
    albums: row?.albums ?? 0,
    tracks: row?.tracks ?? 0,
    lastSync,
  };
}

// ---------------------------------------------------------------- queue writes

/** Same title + artists counts as the same song (e.g. a single that is also on the album). */
const songKey = (t: ShuffleCandidate) => `${t.name.trim().toLowerCase()}\u0000${t.artists.toLowerCase()}`;

/**
 * Replaces the local queue with up to MAX_QUEUE_SIZE songs drawn at random (cryptographically secure
 * RNG, without replacement) from every stored song, except songs that only belong to excluded artists
 * or are removed by the title filters. Songs with the same title + artists are only picked once.
 *
 * `weighting` decides how likely each song is (see ArtistWeighting): with `song` every song is equally
 * likely; otherwise each pick first chooses an artist (equally, or by the square root of their song
 * count) and then one of that artist's songs. With `artistId`, the songs are drawn only from that
 * artist's releases and the weighting does not matter.
 */
export async function generateShuffledQueue(
  db: SQLiteDatabase,
  filters: ShuffleFilters,
  { artistId, weighting = DEFAULT_ARTIST_WEIGHTING }: { artistId?: string; weighting?: ArtistWeighting } = {},
): Promise<number> {
  let picked: ShuffleCandidate[];
  if (artistId) {
    picked = pickRandomUnique(await getArtistShuffleCandidates(db, filters, artistId), MAX_QUEUE_SIZE, songKey);
  } else if (weighting === 'song') {
    picked = pickRandomUnique((await getShuffleCandidates(db, filters)).songs, MAX_QUEUE_SIZE, songKey);
  } else {
    const groups = (await getShuffleCandidates(db, filters)).byArtist.map((items) => ({
      weight: weighting === 'balanced' ? Math.sqrt(items.length) : 1,
      items,
    }));
    picked = pickRandomFromGroups(groups, MAX_QUEUE_SIZE, songKey);
  }

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM queue');
    if (picked.length === 0) return;
    // One statement for all songs (at most 2 × MAX_QUEUE_SIZE parameters) instead of one per song.
    await txn.runAsync(
      `INSERT INTO queue (position, track_id) VALUES ${picked.map(() => '(?, ?)').join(', ')}`,
      picked.flatMap((t, i) => [i, t.id]),
    );
  });
  return picked.length;
}

export async function setArtistExcluded(db: SQLiteDatabase, artistId: string, excluded: boolean) {
  if (excluded) {
    await db.runAsync('INSERT OR IGNORE INTO excluded_artists (artist_id) VALUES (?)', artistId);
  } else {
    await db.runAsync('DELETE FROM excluded_artists WHERE artist_id = ?', artistId);
  }
}

/**
 * The followed, not yet excluded artists a queued song belongs to (through its release), i.e. the
 * artists that can be excluded from it. Usually one; a split release can have several.
 */
export function getExcludableArtistsForTrack(
  db: SQLiteDatabase,
  trackId: string,
): Promise<{ id: string; name: string }[]> {
  return db.getAllAsync(
    `SELECT ar.id, ar.name
     FROM tracks t
     JOIN artist_albums aa ON aa.album_id = t.album_id
     JOIN artists ar       ON ar.id = aa.artist_id
     WHERE t.id = ? AND ar.id NOT IN (SELECT artist_id FROM excluded_artists)
     ORDER BY ar.name COLLATE NOCASE`,
    trackId,
  );
}

/**
 * Excludes an artist from the shuffle and removes their songs from the queue: those that are now out of
 * the shuffle. A song on a release shared with another, still included artist stays (as in the shuffle).
 */
export async function excludeArtistAndRemoveFromQueue(db: SQLiteDatabase, artistId: string): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('INSERT OR IGNORE INTO excluded_artists (artist_id) VALUES (?)', artistId);
    await txn.runAsync(
      `DELETE FROM queue WHERE track_id IN (
         SELECT t.id FROM tracks t
         WHERE t.album_id IN (SELECT album_id FROM artist_albums WHERE artist_id = ?)
           AND NOT ${SHUFFLE_TRACKS_WHERE}
       )`,
      artistId,
    );
  });
}

export async function removeFromQueue(db: SQLiteDatabase, position: number): Promise<void> {
  await db.runAsync('DELETE FROM queue WHERE position = ?', position);
}

export async function clearQueue(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM queue');
}

/**
 * Deletes everything synced from Spotify: artists, releases, songs, the queue and the sync
 * progress (meta). The shuffle filters are kept. Credentials and the Spotify login live in secure storage and are not touched.
 */
export async function clearLibrary(db: SQLiteDatabase): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(`
      DELETE FROM queue;
      DELETE FROM excluded_artists;
      DELETE FROM tracks;
      DELETE FROM artist_albums;
      DELETE FROM albums;
      DELETE FROM artists;
      DELETE FROM meta WHERE key NOT LIKE 'filter!_%' ESCAPE '!';
    `);
  });
  invalidateShuffleCandidates();
}

// ---------------------------------------------------------------- meta

export async function getMeta(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setMeta(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
}
