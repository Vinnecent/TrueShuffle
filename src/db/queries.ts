import type { SQLiteDatabase } from 'expo-sqlite';

import { pickRandomUnique } from '@/lib/shuffle';

export const MAX_QUEUE_SIZE = 75;

export type ArtistRow = {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
  track_count: number;
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
           COUNT(t.id)                 AS track_count
    FROM artists ar
    LEFT JOIN artist_albums aa ON aa.artist_id = ar.id
    LEFT JOIN tracks t         ON t.album_id = aa.album_id
    GROUP BY ar.id
    ORDER BY ar.name COLLATE NOCASE
  `);
}

export function getArtist(db: SQLiteDatabase, artistId: string) {
  return db.getFirstAsync<{ id: string; name: string; image_url: string | null }>(
    'SELECT id, name, image_url FROM artists WHERE id = ?',
    artistId,
  );
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
    albums: row?.albums ?? 0, tracks: row?.tracks ?? 0, lastSync };
}

// ---------------------------------------------------------------- queue writes

/**
 * Replaces the local queue with up to MAX_QUEUE_SIZE songs drawn uniformly at random
 * (without replacement, using a cryptographically secure RNG) from every stored track.
 * Songs with the same title + artists (e.g. a single that is also on the album) are only picked once.
 */
export async function generateShuffledQueue(db: SQLiteDatabase): Promise<number> {
  const all = await db.getAllAsync<{ id: string; name: string; artists: string }>(
    'SELECT id, name, artists FROM tracks',
  );
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

export async function removeFromQueue(db: SQLiteDatabase, position: number): Promise<void> {
  await db.runAsync('DELETE FROM queue WHERE position = ?', position);
}

export async function clearQueue(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM queue');
}

// ---------------------------------------------------------------- meta

export async function getMeta(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM meta WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setMeta(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value);
}
