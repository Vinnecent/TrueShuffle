import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'trueshuffle.db';

/**
 * Creates the local schema if it does not exist yet. Passed to <SQLiteProvider onInit>.
 * There are no migrations before the first release; add `PRAGMA user_version` based ones once a
 * released version needs a schema change.
 */
export async function initDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS artists (
      id               TEXT PRIMARY KEY NOT NULL,
      name             TEXT NOT NULL,
      image_url        TEXT,
      albums_synced_at TEXT                   -- when releases + songs were last fully synced (lets a sync resume)
    );

    CREATE TABLE IF NOT EXISTS albums (
      id           TEXT PRIMARY KEY NOT NULL,
      name         TEXT NOT NULL,
      album_type   TEXT NOT NULL,             -- 'album' | 'single' | 'compilation' (EPs are 'single' in Spotify)
      release_date TEXT,
      total_tracks INTEGER NOT NULL DEFAULT 0,
      image_url    TEXT
    );

    -- An album can belong to several followed artists (collaborations).
    CREATE TABLE IF NOT EXISTS artist_albums (
      artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
      album_id  TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      PRIMARY KEY (artist_id, album_id)
    );
    CREATE INDEX IF NOT EXISTS idx_artist_albums_album ON artist_albums(album_id);

    CREATE TABLE IF NOT EXISTS tracks (
      id           TEXT PRIMARY KEY NOT NULL,
      album_id     TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      uri          TEXT NOT NULL,
      artists      TEXT NOT NULL,             -- display string, e.g. "Artist A, Artist B"
      disc_number  INTEGER NOT NULL DEFAULT 1,
      track_number INTEGER NOT NULL DEFAULT 0,
      duration_ms  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);

    CREATE TABLE IF NOT EXISTS queue (
      position INTEGER PRIMARY KEY NOT NULL,
      track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY NOT NULL,
      value TEXT
    );
  `);
}
