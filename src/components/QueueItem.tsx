import Ionicons from '@expo/vector-icons/Ionicons';
import { memo, useRef, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Artwork } from '@/components/ui';
import type { QueueRow } from '@/db/queries';
import { colors, formatDuration } from '@/theme';

/** How long a row is held before its menu opens (React Native's default is 500 ms). */
const LONG_PRESS_MS = 300;

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
  /** Invisible but keeping its place, e.g. while the queue menu shows a popped-out copy of it. */
  hidden?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Show the cover without fading it in, and report when it is on screen (or there is none). */
  onCoverShown?: () => void;
};

/** One song in the queue list. */
function QueueItemRow({ item, index, current, isPlaying, onLongPress, hidden, style, onCoverShown }: Props) {
  const { t } = useTranslation();
  const ref = useRef<ComponentRef<typeof Pressable>>(null);

  const longPress = onLongPress
    ? () => ref.current?.measureInWindow((x, y, width, height) => onLongPress({ x, y, width, height }))
    : undefined;

  return (
    <Pressable
      ref={ref}
      onLongPress={longPress}
      delayLongPress={LONG_PRESS_MS}
      disabled={!onLongPress}
      style={({ pressed }) => [
        row.container,
        current && row.current,
        pressed && { backgroundColor: colors.highlight },
        hidden && row.hidden,
        style,
      ]}
      accessibilityState={current ? { selected: true } : undefined}
      accessibilityHint={current ? (isPlaying ? t('queue.playingInSpotify') : t('queue.pausedInSpotify')) : undefined}
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
        <Text style={row.index} numberOfLines={1}>
          {index + 1}
        </Text>
      )}
      <Artwork uri={item.image_url} size={44} fadeIn={!onCoverShown} onDisplay={onCoverShown} />
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

/**
 * Re-renders a row only when what it shows changes. Hiding or showing one row (the queue menu) then updates
 * that row alone instead of every visible one, which keeps opening and closing the menu quick. The callbacks
 * are left out on purpose: the list passes new ones on every render, but they always do the same for a row.
 */
export const QueueItem = memo(
  QueueItemRow,
  (prev, next) =>
    prev.item === next.item &&
    prev.index === next.index &&
    prev.current === next.current &&
    prev.isPlaying === next.isPlaying &&
    prev.hidden === next.hidden &&
    prev.style === next.style &&
    !!prev.onLongPress === !!next.onLongPress &&
    !!prev.onCoverShown === !!next.onCoverShown,
);

const row = StyleSheet.create({
  hidden: { opacity: 0 },
  container: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  current: { backgroundColor: colors.surface },
  // Wide enough for three digits (the queue holds up to 100 songs); the icon column matches it.
  index: { color: colors.textMuted, width: 28, textAlign: 'right', fontVariant: ['tabular-nums'] },
  indexIcon: { width: 28, alignItems: 'flex-end' },
  text: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
