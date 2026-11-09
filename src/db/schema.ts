import type { SQLiteDatabase } from 'expo-sqlite';

export const DATABASE_NAME = 'trueshuffle.db';

const DATABASE_VERSION = 2;

/**
 * Creates or upgrades the local schema. Passed to <SQLiteProvider onInit>.
 * Bump DATABASE_VERSION and add a new `if (version < N)` block for future changes.
 */
export async function migrateDbIfNeeded(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = row?.user_version ?? 0;
  if (version >= DATABASE_VERSION) return;

  if (version < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS artists (
        id        TEXT PRIMARY KEY NOT NULL,
        name      TEXT NOT NULL,
        image_url TEXT
      );

      CREATE TABLE IF NOT EXISTS albums (
        id           TEXT PRIMARY KEY NOT NULL,
        name         TEXT NOT NULL,
        album_type   TEXT NOT NULL,          -- 'album' | 'single' | 'compilation' (EPs are 'single' in Spotify)
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
        artists      TEXT NOT NULL,          -- display string, e.g. "Artist A, Artist B"
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
    version = 1;
  }

  if (version < 2) {
    // When this artist's releases + songs were last fully synced; lets an interrupted sync resume.
    await db.execAsync('ALTER TABLE artists ADD COLUMN albums_synced_at TEXT');
    version = 2;
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}
