import Ionicons from '@expo/vector-icons/Ionicons';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { Artwork } from '@/components/ui';
import { getTrackByUri } from '@/db/queries';
import {
  broadcastLengthMs,
  isNowPlayingSupported,
  useIsPlaying,
  useLivePosition,
  type SpotifyPlaybackState,
} from '@/spotify/nowPlaying';
import { colors, formatDuration } from '@/theme';

type StoredTrack = { duration_ms: number; image_url: string | null };

type Props = {
  /** From `useSpotifyNowPlaying()` on the screen, which shares it with the queue list. */
  state: SpotifyPlaybackState | null;
  /** Spotify URIs of the queued songs, in order, to show "Song 3 of 100 in your queue". */
  queueUris: string[];
};

/** "Now playing" card for the song the Spotify app plays. Renders nothing when that is unknown. */
export function NowPlaying({ state, queueUris }: Props) {
  const { t } = useTranslation();
  const db = useSQLiteContext();
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
  const playing = useIsPlaying(state, durationMs);
  const position = useLivePosition(state, playing);

  // Nothing to show on iOS/web (no native module) or until Spotify has broadcast a song,
  // e.g. when "Device Broadcast Status" is off in Spotify's settings.
  if (!isNowPlayingSupported || !state?.title) return null;

  const shownPosition = durationMs ? Math.min(position, durationMs) : position;
  const progress = durationMs ? shownPosition / durationMs : 0;
  const queueIndex = trackId ? queueUris.indexOf(trackId) : -1;

  return (
    <View style={card.container}>
      <View style={card.row}>
        <Artwork uri={stored?.image_url ?? null} size={48} placeholderColor={colors.highlight} />
        <View style={{ flex: 1 }}>
          <Text style={[card.label, !playing && { color: colors.textMuted }]}>
            {playing ? t('nowPlaying.playing') : t('nowPlaying.paused')}
          </Text>
          <Text style={card.title} numberOfLines={1}>
            {state.title}
          </Text>
          <Text style={card.artist} numberOfLines={1}>
            {state.artist}
            {queueIndex >= 0
              ? ` · ${t('nowPlaying.queuePosition', { position: queueIndex + 1, total: queueUris.length })}`
              : ''}
          </Text>
        </View>
        <Ionicons
          name={playing ? 'volume-high' : 'pause'}
          size={22}
          color={playing ? colors.accent : colors.textMuted}
          accessibilityLabel={playing ? t('nowPlaying.playingLabel') : t('nowPlaying.paused')}
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
  container: { padding: 12, borderRadius: 8, backgroundColor: colors.surfaceRaised, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  label: { color: colors.accent, fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 2 },
  artist: { color: colors.textMuted, fontSize: 12, marginTop: 1 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { flex: 1, height: 4, borderRadius: 2, backgroundColor: colors.highlight, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent },
  time: { color: colors.textMuted, fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 32, textAlign: 'center' },
});
