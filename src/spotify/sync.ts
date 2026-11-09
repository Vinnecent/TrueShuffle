import type { SQLiteDatabase } from 'expo-sqlite';

import { getMeta, setMeta } from '@/db/queries';
import {
  getAlbumTracks,
  getArtistAlbums,
  getFollowedArtists,
  pickImage,
  setRateLimitListener,
  type SpotifyAlbum,
  type SpotifyArtist,
  type SpotifyTrack,
} from './api';

export type SyncProgress = {
  phase: string;
  done: number;
  total: number;
  /** Songs stored so far. */
  tracks?: number;
  /** Extra status, e.g. a rate-limit wait. */
  note?: string;
};

export type SyncResult = { artists: number; albums: number; tracks: number; resumed: boolean };

/**
 * Artists processed in parallel. Kept low on purpose: Development Mode apps have a small
 * rate limit, and every artist costs several requests (10 releases per page + one per release).
 */
const CONCURRENCY = 2;

/** Set while a sync is running; if it is still set at the next start, that sync was interrupted. */
export const SYNC_STARTED_KEY = 'sync_started_at';
/** When the last sync (complete or interrupted) ended. */
const LAST_SYNC_KEY = 'last_sync';

/** Runs `worker` over `items` with at most `limit` in flight at once. */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  let failed = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    // Stop handing out new work once any worker failed, so the sync ends promptly.
    while (!failed && index < items.length) {
      try {
        await worker(items[index++]);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  });
  await Promise.all(runners);
}

/** Serialises database transactions coming from concurrent network workers. */
function createWriteLock() {
  let tail: Promise<unknown> = Promise.resolve();
  return <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * Pulls every followed artist, their albums/EPs/singles and all songs from Spotify into the
 * local database.
 *
 * Progress is saved per artist, so the library fills up while syncing and an interrupted sync
 * (rate limit, network loss, app closed) continues where it stopped on the next run.
 * Songs of releases that are already stored are never downloaded again.
 */
export async function syncLibrary(
  db: SQLiteDatabase,
  onProgress: (p: SyncProgress) => void = () => {},
): Promise<SyncResult> {
  const withLock = createWriteLock();
  let last: SyncProgress = { phase: 'Fetching followed artists', done: 0, total: 0 };
  const report = (p: Partial<SyncProgress>) => {
    last = { ...last, note: undefined, ...p };
    onProgress(last);
  };
  setRateLimitListener((seconds) =>
    onProgress({ ...last, note: `Spotify rate limit, waiting ${Math.ceil(seconds)}s…` }),
  );

  // Set as soon as anything was saved, so an interrupted (partial) sync still counts as the last sync.
  let savedAnything = false;
  try {
    const previousStart = await getMeta(db, SYNC_STARTED_KEY);
    const resumed = previousStart !== null;
    const syncStart = previousStart ?? new Date().toISOString();
    if (!resumed) await setMeta(db, SYNC_STARTED_KEY, syncStart);

    // 1. Followed artists (cheap: 50 per request) — saved right away.
    report({ phase: 'Fetching followed artists' });
    const artists = await getFollowedArtists();
    await withLock(() => saveArtists(db, artists));
    savedAnything = true;

    // 2. Releases + songs per artist, skipping artists already finished in this sync run.
    const finished = new Set(
      (
        await db.getAllAsync<{ id: string }>(
          'SELECT id FROM artists WHERE albums_synced_at IS NOT NULL AND albums_synced_at >= ?',
          syncStart,
        )
      ).map((r) => r.id),
    );
    const todo = artists.filter((a) => !finished.has(a.id));
    let done = artists.length - todo.length;
    let tracks = await countTracks(db);
    report({ phase: 'Syncing artists', done, total: artists.length, tracks });

    await runPool(todo, CONCURRENCY, async (artist) => {
      const albums = await getArtistAlbums(artist.id);
      await withLock(() => saveArtistAlbums(db, artist.id, albums));

      const missing = await albumsWithoutTracks(db, albums.map((a) => a.id));
      for (const albumId of missing) {
        const albumTracks = await getAlbumTracks(albumId);
        await withLock(() => saveAlbumTracks(db, albumId, albumTracks));
        tracks += albumTracks.length;
        report({ tracks });
      }

      await withLock(() =>
        db.runAsync('UPDATE artists SET albums_synced_at = ? WHERE id = ?', new Date().toISOString(), artist.id),
      );
      report({ done: ++done });
    });

    // 3. Everything fetched: drop releases no followed artist lists any more.
    //    Cascades remove their songs and any queue entries pointing at them.
    report({ phase: 'Cleaning up', done: 0, total: 0 });
    await withLock(() => db.execAsync('DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM artist_albums)'));
    await db.runAsync('DELETE FROM meta WHERE key = ?', SYNC_STARTED_KEY);

    const totals = await db.getFirstAsync<{ albums: number; tracks: number }>(
      'SELECT (SELECT COUNT(*) FROM albums) AS albums, (SELECT COUNT(*) FROM tracks) AS tracks',
    );
    return { artists: artists.length, albums: totals?.albums ?? 0, tracks: totals?.tracks ?? 0, resumed };
  } finally {
    setRateLimitListener(null);
    if (savedAnything) await setMeta(db, LAST_SYNC_KEY, new Date().toISOString()).catch(() => undefined);
  }
}

async function countTracks(db: SQLiteDatabase): Promise<number> {
  return (await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM tracks'))?.n ?? 0;
}

async function albumsWithoutTracks(db: SQLiteDatabase, albumIds: string[]): Promise<string[]> {
  if (albumIds.length === 0) return [];
  const placeholders = albumIds.map(() => '?').join(',');
  const have = await db.getAllAsync<{ album_id: string }>(
    `SELECT DISTINCT album_id FROM tracks WHERE album_id IN (${placeholders})`,
    albumIds,
  );
  const haveSet = new Set(have.map((r) => r.album_id));
  return albumIds.filter((id) => !haveSet.has(id));
}

/** Upserts followed artists and removes unfollowed ones (cascades to their release links). */
async function saveArtists(db: SQLiteDatabase, artists: SpotifyArtist[]) {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const upsert = await txn.prepareAsync(
      `INSERT INTO artists (id, name, image_url) VALUES ($id, $name, $image)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, image_url = excluded.image_url`,
    );
    try {
      for (const a of artists) {
        await upsert.executeAsync({ $id: a.id, $name: a.name, $image: pickImage(a.images) });
      }
    } finally {
      await upsert.finalizeAsync();
    }

    const followed = new Set(artists.map((a) => a.id));
    const existing = await txn.getAllAsync<{ id: string }>('SELECT id FROM artists');
    for (const { id } of existing) {
      if (!followed.has(id)) await txn.runAsync('DELETE FROM artists WHERE id = ?', id);
    }
  });
}

/** Replaces one artist's release list. */
async function saveArtistAlbums(db: SQLiteDatabase, artistId: string, albums: SpotifyAlbum[]) {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.runAsync('DELETE FROM artist_albums WHERE artist_id = ?', artistId);
    const upsertAlbum = await txn.prepareAsync(
      `INSERT INTO albums (id, name, album_type, release_date, total_tracks, image_url)
       VALUES ($id, $name, $type, $date, $total, $image)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, album_type = excluded.album_type,
         release_date = excluded.release_date, total_tracks = excluded.total_tracks,
         image_url = excluded.image_url`,
    );
    const link = await txn.prepareAsync('INSERT OR IGNORE INTO artist_albums (artist_id, album_id) VALUES (?, ?)');
    try {
      for (const al of albums) {
        await upsertAlbum.executeAsync({
          $id: al.id,
          $name: al.name,
          $type: al.album_type,
          $date: al.release_date ?? null,
          $total: al.total_tracks ?? 0,
          $image: pickImage(al.images),
        });
        await link.executeAsync(artistId, al.id);
      }
    } finally {
      await upsertAlbum.finalizeAsync();
      await link.finalizeAsync();
    }
  });
}

async function saveAlbumTracks(db: SQLiteDatabase, albumId: string, tracks: SpotifyTrack[]) {
  await db.withExclusiveTransactionAsync(async (txn) => {
    const stmt = await txn.prepareAsync(
      // Upsert rather than REPLACE: REPLACE deletes the row first, which would cascade to the queue.
      `INSERT INTO tracks
         (id, album_id, name, uri, artists, disc_number, track_number, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET album_id = excluded.album_id, name = excluded.name,
         uri = excluded.uri, artists = excluded.artists, disc_number = excluded.disc_number,
         track_number = excluded.track_number, duration_ms = excluded.duration_ms`,
    );
    try {
      for (const t of tracks) {
        await stmt.executeAsync(
          t.id,
          albumId,
          t.name,
          t.uri,
          t.artists.map((a) => a.name).join(', '),
          t.disc_number,
          t.track_number,
          t.duration_ms,
        );
      }
    } finally {
      await stmt.finalizeAsync();
    }
  });
}
