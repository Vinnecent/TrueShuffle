import * as BackgroundTask from 'expo-background-task';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

import { ARTIST_REFRESH_AFTER_MS, getLibraryStats, getMeta, setMeta } from '@/db/queries';
import { DATABASE_NAME, initDatabase } from '@/db/schema';
import { RateLimitError } from '@/spotify/api';
import { isLoggedIn, NotAuthenticatedError } from '@/spotify/auth';
import { getRateLimitedUntil, isSyncRunning, syncLibrary } from '@/spotify/sync';
import { t } from '@/i18n';

/**
 * Background sync: Android (WorkManager) runs this every now and then, even when the app is closed.
 * Each run scans the artists not scanned for a week (oldest first) for a few minutes and stops cleanly
 * when Spotify's limit is hit; runs with nothing due, or during a known Spotify block, end immediately
 * without sending any request.
 */
export const BACKGROUND_SYNC_TASK = 'trueshuffle-background-sync';

/** Requested spacing between runs (minutes, at least 15). Android decides the actual timing. */
const MINIMUM_INTERVAL_MINUTES = 60 * 12;
/** Android gives a background run about 10 minutes; stop starting new artists well before that. */
const RUN_BUDGET_MS = 7 * 60_000;

const STATUS_KEY = 'background_sync_status';

/** Result codes of a run; shown as `backgroundSync.<code>` in the language the app has when it is displayed. */
type StatusCode =
  | 'alreadyRunning'
  | 'waitingForLimit'
  | 'notConnected'
  | 'upToDate'
  | 'completed'
  | 'partial'
  | 'rateLimited'
  | 'loginExpired'
  | 'failed';

type RunResult = { code: StatusCode; params?: { count?: number; remaining?: number; message?: string } };

export type BackgroundSyncStatus = RunResult & { at: string };

/** A run's result as text in the current language. */
export function describeBackgroundSyncStatus(status: BackgroundSyncStatus): string {
  return t(`backgroundSync.${status.code}`, status.params ?? {});
}

async function runBackgroundSync(db: SQLite.SQLiteDatabase): Promise<RunResult> {
  if (isSyncRunning()) return { code: 'alreadyRunning' };

  const blockedUntil = await getRateLimitedUntil(db);
  // The Sync button in Settings shows when the wait ends, so the stored message needs no date.
  if (blockedUntil) return { code: 'waitingForLimit' };

  if (!(await isLoggedIn())) return { code: 'notConnected' };

  // Nothing to do (and no request sent) until an included artist's last scan is a week old.
  // Newly followed artists are picked up on the next run that has anything due.
  const stats = await getLibraryStats(db);
  if (stats.artists > 0 && stats.freshArtists >= stats.artists - stats.excludedArtists) {
    return { code: 'upToDate' };
  }

  try {
    const result = await syncLibrary(db, undefined, {
      deadline: Date.now() + RUN_BUDGET_MS,
      olderThanMs: ARTIST_REFRESH_AFTER_MS,
    });
    return result.completed
      ? { code: 'completed', params: { count: result.scanned } }
      : { code: 'partial', params: { count: result.scanned, remaining: result.remaining } };
  } catch (e) {
    if (e instanceof RateLimitError) return { code: 'rateLimited' };
    if (e instanceof NotAuthenticatedError) return { code: 'loginExpired' };
    return { code: 'failed', params: { message: (e as Error).message } };
  }
}

// Must run at module load (imported from the root layout): when Android starts the app in the
// background no React component is mounted, so the task has to be defined globally.
TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  try {
    // A separate connection: the SQLiteProvider is not mounted when the app runs headless.
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    await initDatabase(db);
    const result = await runBackgroundSync(db);
    const status: BackgroundSyncStatus = { at: new Date().toISOString(), ...result };
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
    const status = JSON.parse(raw) as Partial<BackgroundSyncStatus>;
    // Statuses saved before the app was translated have no code; they are replaced by the next run.
    return typeof status.code === 'string' && typeof status.at === 'string' ? (status as BackgroundSyncStatus) : null;
  } catch {
    return null;
  }
}
