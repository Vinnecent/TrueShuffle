import type { SQLiteDatabase } from 'expo-sqlite';

import { pickRandomUnique } from '@/lib/shuffle';

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

export type LibraryStats = {
  artists: number;
  /** Artists whose releases and songs have been fetched at least once. */
  scannedArtists: number;
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

/** Title filters for the shuffle, chosen on the Queue tab. */
export type ShuffleFilters = {
  /** Skip songs with "acoustic" in the title. */
  excludeAcoustic: boolean;
  /** Skip songs with "remix" in the title. */
  excludeRemix: boolean;
  /** Skip live recordings ("Song - Live", "Song (Live at …)", "Song [Live]"). */
  excludeLive: boolean;
};

export const DEFAULT_SHUFFLE_FILTERS: ShuffleFilters = {
  excludeAcoustic: false,
  excludeRemix: false,
  excludeLive: false,
};

/** Meta keys of the filters; Clear library keeps every `filter_` key (they are preferences, not synced data). */
const FILTER_KEYS: Record<keyof ShuffleFilters, string> = {
  excludeAcoustic: 'filter_exclude_acoustic',
  excludeRemix: 'filter_exclude_remix',
  excludeLive: 'filter_exclude_live',
};

/** Titles each filter removes (case-insensitive). */
const FILTER_PATTERNS: Record<keyof ShuffleFilters, RegExp> = {
  excludeAcoustic: /acoustic/i,
  excludeRemix: /remix/i,
  // "live" as a whole word in the version part of the title: after " - " or inside ( ) / [ ].
  // Keeps titles like "Alive", "Olive" or "Live Forever".
  excludeLive: /\s[-–—]\s.*\blive\b|[([][^)\]]*\blive\b/i,
};

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

/** Whether a song title passes the enabled filters. */
export function passesShuffleFilters(title: string, filters: ShuffleFilters): boolean {
  for (const key of Object.keys(FILTER_PATTERNS) as (keyof ShuffleFilters)[]) {
    if (filters[key] && FILTER_PATTERNS[key].test(title)) return false;
  }
  return true;
}

type ShuffleCandidate = { id: string; name: string; artists: string };

/** Songs the shuffle may pick: excluded artists left out in SQL, title filters applied here. */
async function getShuffleCandidates(db: SQLiteDatabase, filters: ShuffleFilters): Promise<ShuffleCandidate[]> {
  const rows = await db.getAllAsync<ShuffleCandidate>(
    `SELECT t.id, t.name, t.artists FROM tracks t WHERE ${SHUFFLE_TRACKS_WHERE}`,
  );
  return rows.filter((t) => passesShuffleFilters(t.name, filters));
}

/** Number of stored songs the shuffle can draw from (excluded artists and filters applied). */
export async function countShuffleTracks(db: SQLiteDatabase, filters: ShuffleFilters): Promise<number> {
  return (await getShuffleCandidates(db, filters)).length;
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

export async function getLibraryStats(db: SQLiteDatabase): Promise<LibraryStats> {
  const row = await db.getFirstAsync<{ artists: number; scanned: number; albums: number; tracks: number }>(`
    SELECT (SELECT COUNT(*) FROM artists) AS artists,
           (SELECT COUNT(*) FROM artists WHERE albums_synced_at IS NOT NULL) AS scanned,
           (SELECT COUNT(*) FROM albums)  AS albums,
           (SELECT COUNT(*) FROM tracks)  AS tracks
  `);
  const lastSync = await getMeta(db, 'last_sync');
  return {
    artists: row?.artists ?? 0,
    scannedArtists: row?.scanned ?? 0,
    albums: row?.albums ?? 0,
    tracks: row?.tracks ?? 0,
    lastSync,
  };
}

// ---------------------------------------------------------------- queue writes

/**
 * Replaces the local queue with up to MAX_QUEUE_SIZE songs drawn uniformly at random
 * (without replacement, using a cryptographically secure RNG) from every stored track,
 * except songs that only belong to excluded artists or are removed by the title filters.
 * Songs with the same title + artists (e.g. a single that is also on the album) are only picked once.
 */
export async function generateShuffledQueue(db: SQLiteDatabase, filters: ShuffleFilters): Promise<number> {
  const all = await getShuffleCandidates(db, filters);
  const picked = pickRandomUnique(all, MAX_QUEUE_SIZE, (t) =>
    `${t.name.trim().toLowerCase()}\u0000${t.artists.toLowerCase()}`,
  );

  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM queue');
    const stmt = await txn.prepareAsync('INSERT INTO queue (position, track_id) VALUES (?, ?)');
    try {
      for (let i = 0; i < picked.length; i++) await stmt.executeAsync(i, picked[i].id);
    } finally {
      await stmt.finalizeAsync();
    }
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
}

// ---------------------------------------------------------------- meta

export async function getMeta(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setMeta(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
}
