import Ionicons from '@expo/vector-icons/Ionicons';
import { useRef, type ComponentRef } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Artwork } from '@/components/ui';
import type { QueueRow } from '@/db/queries';
import { colors, formatDuration } from '@/theme';

/** Where a row is on screen, in window coordinates. */
export type RowLayout = { x: number; y: number; width: number; height: number };

type Props = {
  item: QueueRow;
  index: number;
  /** The song Spotify is playing (or has paused). */
  current: boolean;
  isPlaying: boolean;
  /** Called with the row's position on screen, e.g. to show a menu next to it. */
  onLongPress?: (layout: RowLayout) => void;
  style?: StyleProp<ViewStyle>;
};

/** One song in the queue list. */
export function QueueItem({ item, index, current, isPlaying, onLongPress, style }: Props) {
  const ref = useRef<ComponentRef<typeof Pressable>>(null);

  const longPress = onLongPress
    ? () => ref.current?.measureInWindow((x, y, width, height) => onLongPress({ x, y, width, height }))
    : undefined;

  return (
    <Pressable
      ref={ref}
      onLongPress={longPress}
      disabled={!onLongPress}
      style={({ pressed }) => [
        row.container,
        current && row.current,
        pressed && { backgroundColor: colors.surfaceRaised },
        style,
      ]}
      accessibilityState={current ? { selected: true } : undefined}
      accessibilityHint={current ? (isPlaying ? 'Playing in Spotify' : 'Paused in Spotify') : undefined}
    >
      {current ? (
        <View style={row.indexIcon}>
          <Ionicons
            name={isPlaying ? 'volume-high' : 'pause'}
            size={18}
            color={isPlaying ? colors.accent : colors.textMuted}
          />
        </View>
      ) : (
        <Text style={row.index}>{index + 1}</Text>
      )}
      <Artwork uri={item.image_url} size={44} />
      <View style={row.text}>
        <Text style={[row.title, current && { color: colors.accent }]} numberOfLines={1}>
          {item.name}
        </Text>
        <Text style={row.subtitle} numberOfLines={1}>
          {item.artists} · {item.album_name}
        </Text>
      </View>
      <Text style={row.duration}>{formatDuration(item.duration_ms)}</Text>
    </Pressable>
  );
}

const row = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  current: { backgroundColor: colors.surface },
  index: { color: colors.textMuted, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  indexIcon: { width: 22, alignItems: 'flex-end' },
  text: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
