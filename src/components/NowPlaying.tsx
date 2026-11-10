import Ionicons from '@expo/vector-icons/Ionicons';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Artwork } from '@/components/ui';
import { getTrackByUri } from '@/db/queries';
import { broadcastLengthMs, isNowPlayingSupported, useLivePosition, useSpotifyNowPlaying } from '@/spotify/nowPlaying';
import { colors, formatDuration } from '@/theme';

/** Seconds past the song's end after which a "playing" state is treated as outdated (e.g. Spotify was closed). */
const STALE_AFTER_END_MS = 15_000;

type StoredTrack = { duration_ms: number; image_url: string | null };

type Props = {
  /** Spotify URIs of the queued songs, in order, to show "Song 3 of 75 in your queue". */
  queueUris: string[];
};

/** "Now playing" card for the song the Spotify app plays. Renders nothing when that is unknown. */
export function NowPlaying({ queueUris }: Props) {
  const db = useSQLiteContext();
  const state = useSpotifyNowPlaying();
  const [lookup, setLookup] = useState<{ uri: string; row: StoredTrack | null } | null>(null);

  const trackId = state?.trackId ?? null;
  useEffect(() => {
    if (!trackId) return;
    let cancelled = false;
    getTrackByUri(db, trackId).then((row) => !cancelled && setLookup({ uri: trackId, row }));
    return () => {
      cancelled = true;
    };
  }, [db, trackId]);
  // The library copy of the playing song (cover and exact length), if it is in the library.
  const stored = lookup && lookup.uri === trackId ? lookup.row : null;

  const durationMs = stored?.duration_ms || broadcastLengthMs(state?.length ?? null);
  const position = useLivePosition(state);

  // Nothing to show on iOS/web (no native module) or until Spotify has broadcast a song,
  // e.g. when "Device Broadcast Status" is off in Spotify's settings.
  if (!isNowPlayingSupported || !state?.title) return null;

  const stale = state.playing && durationMs !== null && position > durationMs + STALE_AFTER_END_MS;
  const playing = state.playing && !stale;
  const shownPosition = durationMs ? Math.min(position, durationMs) : position;
  const progress = durationMs ? shownPosition / durationMs : 0;
  const queueIndex = trackId ? queueUris.indexOf(trackId) : -1;

  return (
    <View style={card.container}>
      <View style={card.row}>
        <Artwork uri={stored?.image_url ?? null} size={48} />
        <View style={{ flex: 1 }}>
          <Text style={[card.label, !playing && { color: colors.textMuted }]}>
            {playing ? 'Now playing' : 'Paused'}
          </Text>
          <Text style={card.title} numberOfLines={1}>
            {state.title}
          </Text>
          <Text style={card.artist} numberOfLines={1}>
            {state.artist}
            {queueIndex >= 0 ? ` · Song ${queueIndex + 1} of ${queueUris.length} in your queue` : ''}
          </Text>
        </View>
        <Ionicons
          name={playing ? 'volume-high' : 'pause'}
          size={22}
          color={playing ? colors.accent : colors.textMuted}
          accessibilityLabel={playing ? 'Playing' : 'Paused'}
        />
      </View>
      {durationMs ? (
        <View style={card.progressRow}>
          <Text style={card.time}>{formatDuration(shownPosition)}</Text>
          <View style={card.track}>
            <View style={[card.fill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={card.time}>{formatDuration(durationMs)}</Text>
        </View>
      ) : null}
    </View>
  );
}

const card = StyleSheet.create({
  container: { padding: 12, borderRadius: 8, backgroundColor: colors.surface, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: colors.accent, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
  artist: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
  time: { color: colors.textMuted, fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 32, textAlign: 'center' },
});
