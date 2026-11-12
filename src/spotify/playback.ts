import * as SecureStore from 'expo-secure-store';
import { Linking } from 'react-native';

import { t } from '@/i18n';

import {
  createPlaylist,
  isPlaylistInLibrary,
  playPlaylistFromStart,
  PLAYLIST_REPLACE_LIMIT,
  replacePlaylistItems,
  setPlaybackShuffle,
  SpotifyApiError,
} from './api';
import { PLAYLIST_ID_KEY } from './auth';

const PLAYLIST_NAME = 'TrueShuffle';
const PLAYLIST_DESCRIPTION =
  'A truly random shuffle of the artists you follow. Managed by the TrueShuffle app: its songs are replaced every time you send a new shuffle.';

/** Turns Spotify player errors into something a user can act on. */
export function describePlaybackError(e: unknown): string {
  if (e instanceof SpotifyApiError) {
    if (e.status === 404 || e.reason === 'NO_ACTIVE_DEVICE') {
      return t('errors.noActiveDevice');
    }
    if (e.status === 403 || e.reason === 'PREMIUM_REQUIRED') {
      return t('errors.premiumRequired');
    }
  }
  return (e as Error)?.message ?? String(e);
}

/** The stored TrueShuffle playlist ID (for backups), or null if none was created on this phone yet. */
export function getStoredPlaylistId(): Promise<string | null> {
  return SecureStore.getItemAsync(PLAYLIST_ID_KEY);
}

/** Restores the playlist ID from a backup, unless this phone already has its own. */
export async function restorePlaylistId(id: string): Promise<void> {
  if (!(await SecureStore.getItemAsync(PLAYLIST_ID_KEY))) await SecureStore.setItemAsync(PLAYLIST_ID_KEY, id);
}

/**
 * Returns the ID of the user's TrueShuffle playlist, creating it if it does not exist yet or the user
 * removed it from their library (Spotify never really deletes playlists, it only unfollows them).
 */
async function getOrCreatePlaylist(): Promise<string> {
  const stored = await SecureStore.getItemAsync(PLAYLIST_ID_KEY);
  if (stored && (await isPlaylistInLibrary(stored))) return stored;

  const id = await createPlaylist(PLAYLIST_NAME, PLAYLIST_DESCRIPTION);
  await SecureStore.setItemAsync(PLAYLIST_ID_KEY, id);
  return id;
}

/**
 * Replaces the songs of the TrueShuffle playlist with `uris`, in this exact order.
 * One request (plus one to check/create the playlist); works without an active device or Premium.
 */
export async function sendToSpotifyPlaylist(uris: string[]): Promise<string> {
  const songs = uris.slice(0, PLAYLIST_REPLACE_LIMIT);
  const id = await getOrCreatePlaylist();
  try {
    await replacePlaylistItems(id, songs);
    return id;
  } catch (e) {
    // The stored playlist is gone or no longer ours (e.g. different account): start a new one once.
    if (!(e instanceof SpotifyApiError) || (e.status !== 404 && e.status !== 403)) throw e;
    await SecureStore.deleteItemAsync(PLAYLIST_ID_KEY);
    const fresh = await getOrCreatePlaylist();
    await replacePlaylistItems(fresh, songs);
    return fresh;
  }
}

/**
 * Starts the playlist from song 1 with Spotify's own shuffle turned off, so the TrueShuffle order is kept.
 * Needs Premium and a device with Spotify open.
 */
export async function playSpotifyPlaylist(playlistId: string): Promise<void> {
  await playPlaylistFromStart(playlistId);
  await setPlaybackShuffle(false);
}

/** Opens the playlist in the Spotify app (or in the browser if Spotify is not installed). */
export async function openPlaylistInSpotify(playlistId: string): Promise<void> {
  try {
    await Linking.openURL(`spotify:playlist:${playlistId}`);
  } catch {
    await Linking.openURL(`https://open.spotify.com/playlist/${playlistId}`);
  }
}
