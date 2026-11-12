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
  onClose: () => void;
};

/** Space kept between the menu and the screen edges. */
const EDGE = 16;
const GAP = 8;

/**
 * Context menu for a queued song: the row pops out of the list over a dimmed screen, with its actions
 * below it. Mount it to open; it calls onClose once its closing animation has finished.
 */
export function QueueItemMenu({ target, onRemove, onExclude, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const { item, index, current, isPlaying, layout, artists } = target;
  const [pop] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));
  const [screenHeight, setScreenHeight] = useState<number | null>(null);
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const [closing, setClosing] = useState(false);

  // Move the row up if the actions would not fit below it, but never under the status bar.
  const shift =
    screenHeight === null || menuHeight === null
      ? 0
      : Math.max(
          insets.top + EDGE - layout.y,
          Math.min(0, screenHeight - insets.bottom - EDGE - (layout.y + layout.height + GAP + menuHeight)),
        );
  const ready = screenHeight !== null && menuHeight !== null;

  useEffect(() => {
    if (!ready) return;
    Animated.spring(pop, { toValue: 1, useNativeDriver: true, damping: 18, stiffness: 260, mass: 0.8 }).start();
  }, [ready, pop]);

  /** Back to its place in the list (backdrop tap, back button). */
  const dismiss = () => {
    if (closing) return;
    setClosing(true);
    Animated.timing(pop, { toValue: 0, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(
      () => onClose(),
    );
  };

  /** Runs an action and fades the whole menu out (the row may be gone from the list by then). */
  const choose = (action: () => void) => {
    if (closing) return;
    setClosing(true);
    action();
    Animated.timing(fade, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => onClose());
  };

  const translateY = pop.interpolate({ inputRange: [0, 1], outputRange: [0, shift] });
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
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
          <Animated.View style={[menu.row, { transform: [{ scale }] }]}>
            <QueueItem item={item} index={index} current={current} isPlaying={isPlaying} style={menu.rowInner} />
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
      style={({ pressed }) => [menu.option, pressed && { backgroundColor: colors.surfaceRaised }]}
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
  row: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    elevation: 12,
  },
  rowInner: { backgroundColor: colors.surface },
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
