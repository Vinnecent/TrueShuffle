import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ComponentProps } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { QueueItem, type RowLayout } from '@/components/QueueItem';
import type { QueueRow } from '@/db/queries';
import { colors } from '@/theme';

export type QueueMenuTarget = {
  item: QueueRow;
  index: number;
  current: boolean;
  isPlaying: boolean;
  /** Where the long-pressed row is on screen; the popped-out copy starts there. */
  layout: RowLayout;
  /** Followed artists of the song that can still be excluded (usually one). */
  artists: { id: string; name: string }[];
};

type Props = {
  target: QueueMenuTarget;
  onRemove: (item: QueueRow) => void;
  onExclude: (artistId: string) => void;
  /** The popped-out copy is back over the original row: show the original again (the copy still covers it). */
  onSettled: () => void;
  onClose: () => void;
  /** The popped-out copy is on screen with its cover: hide the original row now. */
  onPopped: () => void;
};

/** Longest wait for the copy's cover to appear (e.g. an image that fails to load) before opening anyway. */
const COVER_TIMEOUT_MS = 300;

/**
 * How long the copy stays over the original row after onSettled, before the menu closes. Android shows
 * the closed dialog and the list's next frame at slightly different times; this keeps the row from blinking.
 */
const HANDOVER_MS = 100;

/** Space kept between the menu and the screen edges. */
const EDGE = 16;
const GAP = 8;

/**
 * Context menu for a queued song: the row pops out of the list over a dimmed screen, with its actions
 * below it. Mount it to open; it calls onSettled and then onClose once its closing animation has finished.
 */
export function QueueItemMenu({ target, onRemove, onExclude, onSettled, onClose, onPopped }: Props) {
  const insets = useSafeAreaInsets();
  const { item, index, current, isPlaying, layout, artists } = target;
  const [pop] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));
  const [screenHeight, setScreenHeight] = useState<number | null>(null);
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);
  // The copy stays invisible until its cover is on screen, so the cover never blinks; the original row
  // under it stays visible until then.
  const [coverShown, setCoverShown] = useState(!item.image_url);

  // Move the row up if the actions would not fit below it, but never under the status bar.
  const shift =
    screenHeight === null || menuHeight === null
      ? 0
      : Math.max(
          insets.top + EDGE - layout.y,
          Math.min(0, screenHeight - insets.bottom - EDGE - (layout.y + layout.height + GAP + menuHeight)),
        );
  const ready = screenHeight !== null && menuHeight !== null && coverShown;

  useEffect(() => {
    if (coverShown) return;
    const timer = setTimeout(() => setCoverShown(true), COVER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [coverShown]);

  useEffect(() => {
    if (!ready) return;
    onPopped();
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 260, mass: 0.8 }).start();
    // onPopped only once, when the copy is first ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pop]);

  /** Back to its place in the list (backdrop tap, back button). */
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    Animated.timing(pop, { toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(
      () => {
        onSettled();
        setTimeout(onClose, HANDOVER_MS);
      },
    );
  };

  /** Runs an action and fades the whole menu out (the row may be gone from the list by then). */
  const choose = (action: () => void) => {
    if (closing) return;
    setClosing(true);
    action();
    Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
      onSettled();
      onClose();
    });
  };

  const translateY = pop.interpolate({ inputRange: [0, 1], outputRange: [0, shift] });
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
  // The row's square background crossfades with a rounded highlight. Opening, it starts in the pressed colour
  // the held row already shows, so nothing changes colour; closing, it fades back to the row's normal
  // background (swapped while invisible), so it looks like the list row again when it lands.
  // Staggered, so one of the two layers is always opaque and the dimmed screen never shows through.
  const plainOpacity = pop.interpolate({ inputRange: [0.5, 1], outputRange: [1, 0], extrapolate: 'clamp' });
  const highlightOpacity = pop.interpolate({ inputRange: [0, 0.5], outputRange: [0, 1], extrapolate: 'clamp' });
  const menuShift = pop.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] });

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={dismiss}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: fade }]}
        onLayout={(e) => setScreenHeight(e.nativeEvent.layout.height)}
      >
        <Animated.View style={[StyleSheet.absoluteFill, menu.backdrop, { opacity: pop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel="Close menu" />
        </Animated.View>

        <Animated.View
          style={{
            position: 'absolute',
            top: layout.y,
            left: layout.x,
            width: layout.width,
            transform: [{ translateY }],
          }}
        >
          <Animated.View style={{ opacity: ready ? 1 : 0, transform: [{ scale }] }}>
            <Animated.View
              style={[
                StyleSheet.absoluteFill,
                {
                  backgroundColor: !closing ? colors.highlight : current ? colors.surface : colors.background,
                  opacity: plainOpacity,
                },
              ]}
            />
            <Animated.View style={[StyleSheet.absoluteFill, menu.highlight, { opacity: highlightOpacity }]} />
            <QueueItem
              item={item}
              index={index}
              current={current}
              isPlaying={isPlaying}
              style={menu.rowInner}
              onCoverShown={() => setCoverShown(true)}
            />
          </Animated.View>

          <Animated.View
            style={[menu.card, { opacity: pop, transform: [{ translateY: menuShift }] }]}
            onLayout={(e) => setMenuHeight(e.nativeEvent.layout.height)}
          >
            <MenuOption
              icon="remove-circle-outline"
              label="Remove from queue"
              onPress={() => choose(() => onRemove(item))}
            />
            {artists.map((artist) => (
              <MenuOption
                key={artist.id}
                icon="ban-outline"
                label={`Exclude ${artist.name}`}
                help="Leaves their songs out of the shuffle and removes them from this queue"
                danger
                onPress={() => choose(() => onExclude(artist.id))}
              />
            ))}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

function MenuOption({
  icon,
  label,
  help,
  danger,
  onPress,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  label: string;
  help?: string;
  danger?: boolean;
  onPress: () => void;
}) {
  const color = danger ? colors.danger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [menu.option, pressed && { backgroundColor: colors.highlight }]}
    >
      <Ionicons name={icon} size={22} color={color} />
      <View style={{ flex: 1 }}>
        <Text style={[menu.label, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {help ? <Text style={menu.help}>{help}</Text> : null}
      </View>
    </Pressable>
  );
}

const menu = StyleSheet.create({
  backdrop: { backgroundColor: 'rgba(0, 0, 0, 0.7)' },
  highlight: { borderRadius: 12, backgroundColor: colors.highlight },
  rowInner: { backgroundColor: 'transparent' },
  card: {
    marginTop: GAP,
    marginHorizontal: EDGE,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  option: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  label: { fontSize: 15, fontWeight: '600' },
  help: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
});
