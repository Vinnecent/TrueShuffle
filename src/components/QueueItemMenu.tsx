import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, BackHandler, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Overlay } from '@/components/Overlay';
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
  /** Followed artists of the song (usually one); excluded ones can be shuffled but not excluded again. */
  artists: { id: string; name: string; excluded: boolean }[];
};

type Props = {
  target: QueueMenuTarget;
  onRemove: (item: QueueRow) => void;
  onExclude: (artistId: string) => void;
  /** Replace the queue with a shuffle of only this artist's songs. */
  onShuffleArtist: (artistId: string) => void;
  /** The popped-out copy is back over the original row: show the original again. */
  onSettled: () => void;
  onClose: () => void;
  /** The popped-out copy is on screen with its cover: hide the original row now. */
  onPopped: () => void;
};

/** Longest wait for the copy's cover to appear (e.g. an image that fails to load) before opening anyway. */
const COVER_TIMEOUT_MS = 300;

/**
 * Closing animations. The menu takes all touches until it is gone (so nothing moves under the flying row),
 * which makes these the time the list cannot be dragged after closing: keep them short.
 */
const CLOSE_MS = 150;

/** Space kept between the menu and the screen edges. */
const EDGE = 16;
const GAP = 8;

/**
 * Context menu for a queued song: the row pops out of the list over a dimmed screen, with its actions
 * below it. Mount it to open; it calls onSettled and then onClose once its closing animation has finished.
 * Drawn in the app's overlay layer (same window as the list, not a Modal), so the list is usable again in the
 * frame the menu goes.
 */
export function QueueItemMenu({ target, onRemove, onExclude, onShuffleArtist, onSettled, onClose, onPopped }: Props) {
  const { t } = useTranslation();
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
    Animated.timing(pop, {
      toValue: 0,
      duration: CLOSE_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(() => {
      // Same window as the list, so revealing the original row and removing the copy land in one frame.
      onSettled();
      onClose();
    });
  };

  /** Runs an action and fades the whole menu out (the row may be gone from the list by then). */
  const choose = (action: () => void) => {
    if (closing) return;
    setClosing(true);
    action();
    Animated.timing(fade, { toValue: 0, duration: CLOSE_MS, useNativeDriver: true }).start(() => {
      onSettled();
      onClose();
    });
  };

  // Android back button closes the menu, like tapping outside it.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss();
      return true;
    });
    return () => subscription.remove();
  });

  const translateY = pop.interpolate({ inputRange: [0, 1], outputRange: [0, shift] });
  const scale = pop.interpolate({ inputRange: [0, 1], outputRange: [1, 1.03] });
  // The row's own background crossfades with the highlight colour. Opening, it starts in the pressed colour
  // the held row already shows, so nothing changes colour; closing, it fades back to the row's normal
  // background (swapped while invisible), so it looks like the list row again when it lands.
  // Staggered, so one of the two layers is always opaque and the dimmed screen never shows through.
  const plainOpacity = pop.interpolate({ inputRange: [0.5, 1], outputRange: [1, 0], extrapolate: 'clamp' });
  const highlightOpacity = pop.interpolate({ inputRange: [0, 0.5], outputRange: [0, 1], extrapolate: 'clamp' });
  const menuShift = pop.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] });

  return (
    <Overlay>
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: fade }]}
        onLayout={(e) => setScreenHeight(e.nativeEvent.layout.height)}
      >
        <Animated.View style={[StyleSheet.absoluteFill, menu.backdrop, { opacity: pop }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityLabel={t('queueMenu.close')} />
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
                menu.plain,
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
              label={t('queueMenu.remove')}
              onPress={() => choose(() => onRemove(item))}
            />
            {artists.map((artist) => (
              <MenuOption
                key={`shuffle-${artist.id}`}
                icon="shuffle"
                label={t('queueMenu.shuffleArtist', { name: artist.name })}
                help={t('queueMenu.shuffleArtistHelp')}
                onPress={() => choose(() => onShuffleArtist(artist.id))}
              />
            ))}
            {artists
              .filter((artist) => !artist.excluded)
              .map((artist) => (
                <MenuOption
                  key={`exclude-${artist.id}`}
                  icon="ban-outline"
                  label={t('queueMenu.exclude', { name: artist.name })}
                  help={t('queueMenu.excludeHelp')}
                  danger
                  onPress={() => choose(() => onExclude(artist.id))}
                />
              ))}
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </Overlay>
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
  // Both layers have the queue row's own rounding, so the corners stay round while they crossfade.
  plain: { borderRadius: 12 },
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
