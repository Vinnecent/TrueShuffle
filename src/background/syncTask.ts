import * as BackgroundTask from 'expo-background-task';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

import { getLibraryStats, getMeta, setMeta } from '@/db/queries';
import { DATABASE_NAME, initDatabase } from '@/db/schema';
import { RateLimitError } from '@/spotify/api';
import { isLoggedIn, NotAuthenticatedError } from '@/spotify/auth';
import {
  getRateLimitedUntil,
  isSyncRunning,
  LAST_FULL_SYNC_KEY,
  SYNC_STARTED_KEY,
  syncLibrary,
} from '@/spotify/sync';
import { countLabel, formatDateTime } from '@/theme';

/**
 * Background sync: Android (WorkManager) runs this every now and then, even when the app is closed.
 * Each run continues an unfinished sync for a few minutes and stops cleanly when Spotify's limit is hit;
 * runs during a known Spotify block end immediately without sending any request.
 */
export const BACKGROUND_SYNC_TASK = 'trueshuffle-background-sync';

/** Requested spacing between runs (minutes, at least 15). Android decides the actual timing. */
const MINIMUM_INTERVAL_MINUTES = 60 * 12;
/** Android gives a background run about 10 minutes; stop starting new artists well before that. */
const RUN_BUDGET_MS = 7 * 60_000;
/** After a complete sync, start a fresh one (new releases, new follows) once it is this old. */
const FULL_RESYNC_AFTER_MS = 7 * 24 * 60 * 60_000;

const STATUS_KEY = 'background_sync_status';

export type BackgroundSyncStatus = { at: string; message: string };


async function runBackgroundSync(db: SQLite.SQLiteDatabase): Promise<string> {
  if (isSyncRunning()) return 'Skipped: a sync was already running in the app.';

  const blockedUntil = await getRateLimitedUntil(db);
  if (blockedUntil) return `Waiting for Spotify’s limit to end (${formatDateTime(blockedUntil)}).`;

  if (!(await isLoggedIn())) return 'Not connected to Spotify. Sync once in the app to log in.';

  const interrupted = (await getMeta(db, SYNC_STARTED_KEY)) !== null;
  const lastFull = await getMeta(db, LAST_FULL_SYNC_KEY);
  if (!interrupted && lastFull && Date.now() - Date.parse(lastFull) < FULL_RESYNC_AFTER_MS) {
    return 'Library is up to date.';
  }

  try {
    const result = await syncLibrary(db, undefined, { deadline: Date.now() + RUN_BUDGET_MS });
    const stats = await getLibraryStats(db);
    return result.completed
      ? `Sync complete: ${countLabel(stats.tracks, 'song')}.`
      : `Synced for a while (${stats.scannedArtists} of ${stats.artists} artists scanned). Continues next run.`;
  } catch (e) {
    if (e instanceof RateLimitError) {
      const until = await getRateLimitedUntil(db);
      return `Spotify’s limit reached. Continues after ${until ? formatDateTime(until) : 'the wait'}.`;
    }
    if (e instanceof NotAuthenticatedError) return 'Spotify login expired. Sync once in the app to log in again.';
    return `Failed: ${(e as Error).message}`;
  }
}

// Must run at module load (imported from the root layout): when Android starts the app in the
// background no React component is mounted, so the task has to be defined globally.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // A separate connection: the SQLiteProvider is not mounted when the app runs headless.
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    await initDatabase(db);
    const message = await runBackgroundSync(db);
    const status: BackgroundSyncStatus = { at: new Date().toISOString(), message };
    await setMeta(db, STATUS_KEY, JSON.stringify(status));
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.error('Background sync failed', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function isBackgroundSyncAvailable(): Promise<boolean> {
  return (await BackgroundTask.getStatusAsync()) === BackgroundTask.BackgroundTaskStatus.Available;
}

export function isBackgroundSyncEnabled(): Promise<boolean> {
  return TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
}

export async function setBackgroundSyncEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
  } else if (await isBackgroundSyncEnabled()) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}

export async function getBackgroundSyncStatus(db: SQLite.SQLiteDatabase): Promise<BackgroundSyncStatus | null> {
  const raw = await getMeta(db, STATUS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackgroundSyncStatus;
  } catch {
    return null;
  }
}
