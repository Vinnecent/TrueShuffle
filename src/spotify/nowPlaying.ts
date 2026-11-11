import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';

import SpotifyNowPlaying, { type SpotifyPlaybackState } from '../../modules/spotify-now-playing';

export type { SpotifyPlaybackState };

/** True on Android builds that include the native module (not on iOS, web or Expo Go). */
export const isNowPlayingSupported = SpotifyNowPlaying !== null;

/**
 * What the Spotify app on this phone is playing, from its "Device Broadcast Status" broadcasts.
 * Listens only while the calling screen is focused. Returns null until Spotify has broadcast something
 * (which needs the setting turned on in Spotify).
 */
export function useSpotifyNowPlaying(): SpotifyPlaybackState | null {
  const [state, setState] = useState<SpotifyPlaybackState | null>(() => SpotifyNowPlaying?.getState() ?? null);

  useFocusEffect(
    useCallback(() => {
      if (!SpotifyNowPlaying) return;
      // Adding the first listener registers the native receiver, which delivers Spotify's last
      // (sticky) broadcast straight away; removing it unregisters the receiver.
      const subscription = SpotifyNowPlaying.addListener('onChange', setState);
      setState(SpotifyNowPlaying.getState());
      return () => subscription.remove();
    }, []),
  );

  return state;
}

/**
 * Song length in ms. Spotify documents `length` in seconds, but some app versions send milliseconds.
 * A value over 36,000 can only be milliseconds (36,000 seconds would be a 10-hour song).
 * Only a fallback: songs in the library use their stored duration instead.
 */
export function broadcastLengthMs(length: number | null): number | null {
  if (!length || length <= 0) return null;
  return length > 36_000 ? length : length * 1000;
}

/**
 * Current playback position, advancing on its own while `ticking` (re-renders once a second).
 * Pass `useIsPlaying(…)` as `ticking`, so the clock stops once a "playing" state is outdated.
 */
export function useLivePosition(state: SpotifyPlaybackState | null, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking, state]);

  if (!state) return 0;
  const elapsed = state.playing ? Math.max(0, now - state.positionAt) : 0;
  return state.positionMs + elapsed;
}

/** How long past a song's end a "playing" state counts as outdated (e.g. Spotify was closed mid-song). */
const STALE_AFTER_END_MS = 15_000;

/**
 * Whether Spotify is really playing. Spotify sends nothing when it is closed, so a "playing" state is
 * treated as outdated once the song should have ended (plus a margin). Uses one timer, not a ticking clock.
 */
export function useIsPlaying(state: SpotifyPlaybackState | null, durationMs: number | null): boolean {
  const [staleState, setStaleState] = useState<SpotifyPlaybackState | null>(null);

  useEffect(() => {
    if (!state?.playing || !durationMs) return;
    const outdatedAt = state.positionAt + (durationMs - state.positionMs) + STALE_AFTER_END_MS;
    const timer = setTimeout(() => setStaleState(state), Math.max(0, outdatedAt - Date.now()));
    return () => clearTimeout(timer);
  }, [state, durationMs]);

  return !!state?.playing && staleState !== state;
}
