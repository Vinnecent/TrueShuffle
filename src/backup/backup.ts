import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { SQLiteDatabase } from 'expo-sqlite';

import { invalidateShuffleCandidates } from '@/db/queries';
import { t } from '@/i18n';
import type { Translations } from '@/i18n/locales/en';
import { getStoredPlaylistId, restorePlaylistId, SENT_QUEUE_KEY } from '@/spotify/playback';

/**
 * Library backup as a minified JSON file, to move the synced library to another phone.
 *
 * Contains artists (with their scan dates, so nothing is rescanned), releases, songs, the
 * artist ↔ release links, excluded artists, the queue, the shuffle settings (`filter_` meta keys), the
 * last sync date and the ID of the TrueShuffle playlist in Spotify (so the new phone reuses it).
 * Leaves out everything that must not or need not travel: Spotify credentials and login (they live in
 * secure storage, not in the database), cached artwork, rate-limit waits and background-sync status.
 *
 * To keep the file small, rows are stored as arrays instead of objects, a song's URI is left out when
 * it is the usual `spotify:track:<id>`, and the start most artwork URLs share (e.g.
 * `https://i.scdn.co/image/`) is stored once as `imagePrefix` and left out of each of those URLs.
 */

const APP = 'TrueShuffle';
/** Version of the file layout, checked on import. */
const FORMAT = 1;

type ArtistRow = [id: string, name: string, image: string | null, scannedAt: string | null];
type AlbumRow = [
  id: string,
  name: string,
  type: string,
  releaseDate: string | null,
  totalTracks: number,
  image: string | null,
];
type ArtistAlbumRow = [artistId: string, albumId: string];
/** The URI is only present when it is not `spotify:track:<id>`. */
type TrackRow =
  | [id: string, albumId: string, name: string, artists: string, disc: number, track: number, durationMs: number]
  | [
      id: string,
      albumId: string,
      name: string,
      artists: string,
      disc: number,
      track: number,
      durationMs: number,
      uri: string,
    ];

export type Backup = {
  app: typeof APP;
  format: number;
  exportedAt: string;
  /** Left out of the start of the artwork URLs that begin with it ("" if none were shortened). */
  imagePrefix: string;
  artists: ArtistRow[];
  albums: AlbumRow[];
  artistAlbums: ArtistAlbumRow[];
  tracks: TrackRow[];
  /** IDs of artists excluded from the shuffle. */
  excluded: string[];
  /** Track IDs of the queue, in order. */
  queue: string[];
  /** Shuffle settings: the `filter_` meta keys and their values. */
  settings: Record<string, string>;
  lastSync: string | null;
  /** The TrueShuffle playlist in Spotify; not a secret, it only identifies the playlist. */
  playlistId: string | null;
};

export type BackupSummary = { exportedAt: string; artists: number; albums: number; tracks: number };

/** Thrown for a file that is not a (readable) TrueShuffle backup; the message is shown to the user. */
export class InvalidBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBackupError';
  }
}

/** The most common start of the artwork URLs, up to and including the last "/". */
function commonImagePrefix(urls: (string | null)[]): string {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const end = url?.lastIndexOf('/') ?? -1;
    if (!url || end < 0) continue;
    const prefix = url.slice(0, end + 1);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [prefix, count] of counts) {
    if (count > bestCount) [best, bestCount] = [prefix, count];
  }
  return best;
}

const shortImage = (url: string | null, prefix: string) =>
  prefix && url?.startsWith(prefix) ? url.slice(prefix.length) : url;
/** Shortened values contain no "://"; URLs with another start were stored in full. */
const fullImage = (value: string | null, prefix: string) => (value && !value.includes('://') ? prefix + value : value);
const defaultTrackUri = (id: string) => `spotify:track:${id}`;

// ---------------------------------------------------------------- export

async function buildBackup(db: SQLiteDatabase): Promise<Backup> {
  const [artists, albums, links, tracks, excluded, queue, settings, lastSync, playlistId] = await Promise.all([
    db.getAllAsync<{ id: string; name: string; image_url: string | null; albums_synced_at: string | null }>(
      'SELECT id, name, image_url, albums_synced_at FROM artists',
    ),
    db.getAllAsync<{
      id: string;
      name: string;
      album_type: string;
      release_date: string | null;
      total_tracks: number;
      image_url: string | null;
    }>('SELECT id, name, album_type, release_date, total_tracks, image_url FROM albums'),
    db.getAllAsync<{ artist_id: string; album_id: string }>('SELECT artist_id, album_id FROM artist_albums'),
    db.getAllAsync<{
      id: string;
      album_id: string;
      name: string;
      uri: string;
      artists: string;
      disc_number: number;
      track_number: number;
      duration_ms: number;
    }>('SELECT id, album_id, name, uri, artists, disc_number, track_number, duration_ms FROM tracks'),
    db.getAllAsync<{ artist_id: string }>('SELECT artist_id FROM excluded_artists'),
    db.getAllAsync<{ track_id: string }>('SELECT track_id FROM queue ORDER BY position'),
    db.getAllAsync<{ key: string; value: string | null }>(
      `SELECT key, value FROM meta WHERE key LIKE 'filter!_%' ESCAPE '!'`,
    ),
    db.getFirstAsync<{ value: string | null }>(`SELECT value FROM meta WHERE key = 'last_sync'`),
    getStoredPlaylistId(),
  ]);

  const imagePrefix = commonImagePrefix([...artists, ...albums].map((x) => x.image_url));
  return {
    app: APP,
    format: FORMAT,
    exportedAt: new Date().toISOString(),
    imagePrefix,
    artists: artists.map((a) => [a.id, a.name, shortImage(a.image_url, imagePrefix), a.albums_synced_at]),
    albums: albums.map((a) => [
      a.id,
      a.name,
      a.album_type,
      a.release_date,
      a.total_tracks,
      shortImage(a.image_url, imagePrefix),
    ]),
    artistAlbums: links.map((l) => [l.artist_id, l.album_id]),
    tracks: tracks.map((t): TrackRow => {
      const row: TrackRow = [t.id, t.album_id, t.name, t.artists, t.disc_number, t.track_number, t.duration_ms];
      return t.uri === defaultTrackUri(t.id) ? row : [...row, t.uri];
    }),
    excluded: excluded.map((e) => e.artist_id),
    queue: queue.map((q) => q.track_id),
    settings: Object.fromEntries(settings.filter((s) => s.value !== null).map((s) => [s.key, s.value as string])),
    lastSync: lastSync?.value ?? null,
    playlistId,
  };
}

const JSON_MIME = 'application/json';

/** e.g. "TrueShuffle-backup-11-11-2026.json" (dd-mm-yyyy). */
function backupFileName(exportedAt: string): string {
  const d = new Date(exportedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `TrueShuffle-backup-${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}.json`;
}

/** The picker rejects with this message when the user backs out of it. */
const isPickerCancelled = (e: unknown) => /cancel/i.test((e as Error)?.message ?? '');

/**
 * Lets the user choose a folder on the phone (Downloads, Documents, …) and saves the backup there as a
 * minified JSON file. Returns the file name, or null if the folder picker was cancelled.
 */
export async function saveLibraryToFolder(db: SQLiteDatabase): Promise<string | null> {
  let folder: Directory;
  try {
    folder = await Directory.pickDirectoryAsync();
  } catch (e) {
    if (isPickerCancelled(e)) return null;
    throw e;
  }
  const backup = await buildBackup(db);
  // Android picks a free name ("… (1).json") if a file with this name is already in the folder.
  const file = folder.createFile(backupFileName(backup.exportedAt), JSON_MIME);
  await file.write(JSON.stringify(backup));
  return file.name;
}

/**
 * Writes the backup to a minified JSON file and opens Android's share menu, so it can be sent or saved
 * to a cloud drive. Only the latest shared export is kept in the app's cache.
 */
export async function shareLibrary(db: SQLiteDatabase): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error(t('errors.sharingUnavailable'));

  const backup = await buildBackup(db);
  const folder = new Directory(Paths.cache, 'backup');
  if (folder.exists) folder.delete();
  folder.create();

  const file = new File(folder, backupFileName(backup.exportedAt));
  file.create();
  await file.write(JSON.stringify(backup));

  await Sharing.shareAsync(file.uri, { mimeType: JSON_MIME, dialogTitle: t('backup.shareTitle') });
}

// ---------------------------------------------------------------- import

const isString = (v: unknown): v is string => typeof v === 'string';
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isInteger(v);

type BackupPart = keyof Translations['backup']['part'];

const missingPart = (part: BackupPart) =>
  new InvalidBackupError(t('backup.missingPart', { part: t(`backup.part.${part}`) }));
const damagedPart = (part: BackupPart) =>
  new InvalidBackupError(t('backup.damagedPart', { part: t(`backup.part.${part}`) }));

function checkRows<T>(value: unknown, name: BackupPart, isRow: (row: unknown[]) => boolean): T[] {
  if (!Array.isArray(value)) throw missingPart(name);
  for (const row of value) {
    if (!Array.isArray(row) || !isRow(row)) throw damagedPart(name);
  }
  return value as T[];
}

/** Parses and checks a backup file's text; throws InvalidBackupError with a readable reason. */
export function parseBackup(text: string): Backup {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new InvalidBackupError(t('backup.notABackup'));
  }
  if (!data || typeof data !== 'object' || data.app !== APP) {
    throw new InvalidBackupError(t('backup.notABackup'));
  }
  if (data.format !== FORMAT) {
    throw new InvalidBackupError(t('backup.otherVersion'));
  }
  if (!isString(data.exportedAt)) throw new InvalidBackupError(t('backup.damaged'));

  const settings = data.settings ?? {};
  if (
    typeof settings !== 'object' ||
    Object.entries(settings as object).some(([k, v]) => !k.startsWith('filter_') || !isString(v))
  ) {
    throw damagedPart('settings');
  }
  if (
    !isString(data.imagePrefix) ||
    !isNullableString(data.lastSync ?? null) ||
    !isNullableString(data.playlistId ?? null)
  ) {
    throw new InvalidBackupError(t('backup.damaged'));
  }
  const ids = (value: unknown, name: BackupPart) => {
    if (!Array.isArray(value) || !value.every(isString)) throw damagedPart(name);
    return value as string[];
  };

  return {
    app: APP,
    format: FORMAT,
    exportedAt: data.exportedAt,
    imagePrefix: data.imagePrefix,
    artists: checkRows<ArtistRow>(
      data.artists,
      'artists',
      (r) => r.length === 4 && isString(r[0]) && isString(r[1]) && isNullableString(r[2]) && isNullableString(r[3]),
    ),
    albums: checkRows<AlbumRow>(
      data.albums,
      'releases',
      (r) =>
        r.length === 6 &&
        isString(r[0]) &&
        isString(r[1]) &&
        isString(r[2]) &&
        isNullableString(r[3]) &&
        isInt(r[4]) &&
        isNullableString(r[5]),
    ),
    artistAlbums: checkRows<ArtistAlbumRow>(
      data.artistAlbums,
      'releaseLinks',
      (r) => r.length === 2 && isString(r[0]) && isString(r[1]),
    ),
    tracks: checkRows<TrackRow>(
      data.tracks,
      'songs',
      (r) =>
        (r.length === 7 || (r.length === 8 && isString(r[7]))) &&
        isString(r[0]) &&
        isString(r[1]) &&
        isString(r[2]) &&
        isString(r[3]) &&
        isInt(r[4]) &&
        isInt(r[5]) &&
        isInt(r[6]),
    ),
    excluded: ids(data.excluded ?? [], 'excludedArtists'),
    queue: ids(data.queue ?? [], 'queue'),
    settings: settings as Record<string, string>,
    lastSync: (data.lastSync as string | null | undefined) ?? null,
    playlistId: (data.playlistId as string | null | undefined) ?? null,
  };
}

export function summarizeBackup(backup: Backup): BackupSummary {
  return {
    exportedAt: backup.exportedAt,
    artists: backup.artists.length,
    albums: backup.albums.length,
    tracks: backup.tracks.length,
  };
}

/** Lets the user pick a backup file and returns it checked, or null if the picker was cancelled. */
export async function pickBackup(): Promise<Backup | null> {
  // Any type: depending on where the file comes from (Drive, Downloads, a chat app), Android may not
  // report it as application/json. The content check below rejects anything that is not a backup.
  const result = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true });
  if (result.canceled) return null;
  const file = new File(result.assets[0].uri);
  try {
    return parseBackup(await file.text());
  } finally {
    if (file.exists) file.delete();
  }
}

/**
 * Replaces the library with the backup in one transaction: if anything fails (e.g. a damaged file
 * with a song pointing to a missing release), nothing is changed. Credentials, login and the other
 * settings of this phone are kept; the shuffle settings are taken from the backup.
 */
export async function importLibrary(db: SQLiteDatabase, backup: Backup): Promise<void> {
  await db.withExclusiveTransactionAsync(async (txn) => {
    await txn.execAsync(`
      DELETE FROM queue;
      DELETE FROM excluded_artists;
      DELETE FROM tracks;
      DELETE FROM artist_albums;
      DELETE FROM albums;
      DELETE FROM artists;
      DELETE FROM meta WHERE key LIKE 'filter!_%' ESCAPE '!';
    `);
    // The imported queue was not sent from this phone.
    await txn.runAsync('DELETE FROM meta WHERE key = ?', SENT_QUEUE_KEY);

    const insertAll = async <T>(sql: string, rows: T[], params: (row: T) => (string | number | null)[]) => {
      const stmt = await txn.prepareAsync(sql);
      try {
        for (const row of rows) await stmt.executeAsync(params(row));
      } finally {
        await stmt.finalizeAsync();
      }
    };

    await insertAll(
      'INSERT INTO artists (id, name, image_url, albums_synced_at) VALUES (?, ?, ?, ?)',
      backup.artists,
      (a) => [a[0], a[1], fullImage(a[2], backup.imagePrefix), a[3]],
    );
    await insertAll(
      'INSERT INTO albums (id, name, album_type, release_date, total_tracks, image_url) VALUES (?, ?, ?, ?, ?, ?)',
      backup.albums,
      (a) => [a[0], a[1], a[2], a[3], a[4], fullImage(a[5], backup.imagePrefix)],
    );
    await insertAll(
      'INSERT OR IGNORE INTO artist_albums (artist_id, album_id) VALUES (?, ?)',
      backup.artistAlbums,
      (l) => [l[0], l[1]],
    );
    await insertAll(
      `INSERT INTO tracks (id, album_id, name, uri, artists, disc_number, track_number, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      backup.tracks,
      (t) => [t[0], t[1], t[2], t[7] ?? defaultTrackUri(t[0]), t[3], t[4], t[5], t[6]],
    );
    await insertAll('INSERT OR IGNORE INTO excluded_artists (artist_id) VALUES (?)', backup.excluded, (id) => [id]);
    await insertAll(
      'INSERT INTO queue (position, track_id) VALUES (?, ?)',
      backup.queue.map((id, position) => [position, id] as const),
      ([position, id]) => [position, id],
    );
    await insertAll('INSERT INTO meta (key, value) VALUES (?, ?)', Object.entries(backup.settings), ([k, v]) => [k, v]);
    if (backup.lastSync) {
      await txn.runAsync(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)`, backup.lastSync);
    }
  });
  // An imported library can look the same as the old one to the shuffle's change check.
  invalidateShuffleCandidates();
  if (backup.playlistId) await restorePlaylistId(backup.playlistId);
}
