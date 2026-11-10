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

/** Current playback position, advancing on its own while playing (re-renders once a second). */
export function useLivePosition(state: SpotifyPlaybackState | null): number {
  const [now, setNow] = useState(() => Date.now());
  const playing = state?.playing ?? false;

  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playing, state]);

  if (!state) return 0;
  const elapsed = playing ? Math.max(0, now - state.positionAt) : 0;
  return state.positionMs + elapsed;
}
