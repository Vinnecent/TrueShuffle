import type { SQLiteDatabase } from 'expo-sqlite';

import { getMeta, setMeta } from '@/db/queries';
import {
  getAlbumTracks,
  RateLimitError,
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

export type SyncResult = {
  /** Followed artists, including excluded ones. */
  artists: number;
  albums: number;
  tracks: number;
  /** Artists scanned in this run. */
  scanned: number;
  /** Artists that were due but not reached because the time budget ran out (they go first next time). */
  remaining: number;
  /** False when the sync stopped early because its time budget ran out. */
  completed: boolean;
};

export type SyncOptions = {
  /** Epoch ms after which no new artist is started; the sync then saves and returns early. */
  deadline?: number;
  /**
   * Only scan artists last scanned at least this long ago (never-scanned artists always qualify).
   * Defaults to MANUAL_RESCAN_AFTER_MS.
   */
  olderThanMs?: number;
};

/**
 * "Sync now" in Settings skips artists scanned within this time (its "up to date" alert says "the last hour"), so syncing again after an
 * interruption (rate limit, network loss) continues with the rest instead of starting over.
 */
export const MANUAL_RESCAN_AFTER_MS = 60 * 60_000;

/** Thrown when a sync is started while another one (foreground or background) is still running. */
export class SyncInProgressError extends Error {
  constructor() {
    super('A sync is already running.');
    this.name = 'SyncInProgressError';
  }
}

/**
 * Artists processed in parallel. Kept low on purpose: Development Mode apps have a small
 * rate limit, and every artist costs several requests (10 releases per page + one per release).
 */
const CONCURRENCY = 2;

/** When the last sync (complete or interrupted) ended. */
const LAST_SYNC_KEY = 'last_sync';
/** Meta keys of the earlier pass-based sync, removed on the next sync. */
const OBSOLETE_META_KEYS = ['sync_started_at', 'last_full_sync'];
/** Epoch ms until which Spotify asked us not to send requests (from the last long 429). */
export const RATE_LIMITED_UNTIL_KEY = 'rate_limited_until';

let running = false;

/** Whether a sync is running right now in this JS runtime. */
export function isSyncRunning(): boolean {
  return running;
}

/** When Spotify's last long rate-limit block ends, or null if there is none (or it is over). */
export async function getRateLimitedUntil(db: SQLiteDatabase): Promise<Date | null> {
  const value = Number(await getMeta(db, RATE_LIMITED_UNTIL_KEY));
  return Number.isFinite(value) && value > Date.now() ? new Date(value) : null;
}
/**
 * Runs `worker` over `items` with at most `limit` in flight at once.
 * Stops handing out new items once a worker failed or `shouldStop()` returns true.
 */
async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
) {
  let index = 0;
  let failed = false;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && !shouldStop() && index < items.length) {
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
 * Brings the library up to date, oldest first: fetches the followed artists, then scans the artists
 * whose releases were never fetched or were fetched longest ago, until all due artists are done or
 * the deadline is reached. Artists excluded from the shuffle are not scanned; their stored releases
 * stay as they are, and once included again their old scan date puts them at the front.
 *
 * Every artist is saved as soon as it is scanned, so an interrupted run loses nothing: the artists it
 * did not reach are still the oldest and go first next time. Songs of stored releases are never
 * downloaded again, so rescanning an artist only costs its release list.
 */
export async function syncLibrary(
  db: SQLiteDatabase,
  onProgress: (p: SyncProgress) => void = () => {},
  { deadline = Infinity, olderThanMs = MANUAL_RESCAN_AFTER_MS }: SyncOptions = {},
): Promise<SyncResult> {
  if (running) throw new SyncInProgressError();
  running = true;
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
    const placeholders = OBSOLETE_META_KEYS.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM meta WHERE key IN (${placeholders})`, OBSOLETE_META_KEYS);

    // 1. Followed artists (cheap: 50 per request) — saved right away; unfollowed artists are removed.
    report({ phase: 'Fetching followed artists' });
    const artists = await getFollowedArtists();
    await withLock(() => saveArtists(db, artists));
    savedAnything = true;

    // 2. Due artists, never scanned first, then oldest scan first.
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const due = await db.getAllAsync<{ id: string }>(
      `SELECT id FROM artists
       WHERE id NOT IN (SELECT artist_id FROM excluded_artists)
         AND (albums_synced_at IS NULL OR albums_synced_at < ?)
       ORDER BY albums_synced_at IS NOT NULL, albums_synced_at`,
      cutoff,
    );
    let done = 0;
    let tracks = await countTracks(db);
    report({ phase: 'Syncing artists', done, total: due.length, tracks });

    await runPool(due, CONCURRENCY, async (artist) => {
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
    }, () => Date.now() >= deadline);

    // 3. Drop releases no followed artist lists any more (an artist's list is replaced whenever it is
    //    scanned, so this is correct after any run). Cascades remove their songs and queue entries.
    report({ phase: 'Cleaning up', done: 0, total: 0 });
    await withLock(() => db.execAsync('DELETE FROM albums WHERE id NOT IN (SELECT album_id FROM artist_albums)'));

    const totals = await db.getFirstAsync<{ albums: number; tracks: number }>(
      'SELECT (SELECT COUNT(*) FROM albums) AS albums, (SELECT COUNT(*) FROM tracks) AS tracks',
    );
    return {
      artists: artists.length,
      albums: totals?.albums ?? 0,
      tracks: totals?.tracks ?? 0,
      scanned: done,
      remaining: due.length - done,
      completed: done === due.length,
    };
  } catch (e) {
    if (e instanceof RateLimitError) {
      // Remember the block so neither the background task nor the UI sends requests before it ends.
      await setMeta(db, RATE_LIMITED_UNTIL_KEY, String(Date.now() + e.retryAfterSeconds * 1000)).catch(
        () => undefined,
      );
    }
    throw e;
  } finally {
    running = false;
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
