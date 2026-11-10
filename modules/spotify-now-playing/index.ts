import { requireOptionalNativeModule, type NativeModule } from 'expo';

/** What the Spotify app last broadcast (Android only, needs "Device Broadcast Status" on in Spotify). */
export type SpotifyPlaybackState = {
  /** Spotify URI, e.g. "spotify:track:4uLU6hMCjMI75M1A2tKUQC". */
  trackId: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Song length as Spotify sends it (documented as seconds; some versions send milliseconds). */
  length: number | null;
  playing: boolean;
  /** Playback position at `positionAt`. */
  positionMs: number;
  /** When `positionMs` was measured, in ms since the epoch (same clock as `Date.now()`). */
  positionAt: number;
};

type SpotifyNowPlayingEvents = {
  onChange(state: SpotifyPlaybackState): void;
};

declare class SpotifyNowPlayingModule extends NativeModule<SpotifyNowPlayingEvents> {
  getState(): SpotifyPlaybackState | null;
}

/** null where the native module does not exist (iOS, web, Expo Go). */
export default requireOptionalNativeModule<SpotifyNowPlayingModule>('SpotifyNowPlaying');
