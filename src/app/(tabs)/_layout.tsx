import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { PlatformPressable } from 'expo-router/react-navigation';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';

import { hasGenres } from '@/db/queries';
import { onGenresChanged } from '@/genres/events';
import { colors } from '@/theme';

/**
 * The default tab button uses a *borderless* Android ripple: an unclipped circle that spills out of
 * the tab, up over the screen content and down behind the transparent system navigation bar.
 * This keeps the ripple inside the tab's own rectangle (which ends above the navigation bar).
 */
function TabBarButton(props: BottomTabBarButtonProps) {
  return (
    <PlatformPressable
      {...props}
      android_ripple={{ borderless: false, foreground: true, color: 'rgba(255, 255, 255, 0.2)' }}
    />
  );
}

/** How long the Genres tab takes to appear or go. */
const COLLAPSE_MS = 250;

/** Whether any genre is stored (null until known), kept up to date when a sync or Clear genres changes them. */
function useHasGenres(): boolean | null {
  const db = useSQLiteContext();
  const [has, setHas] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const check = () => {
      hasGenres(db).then((value) => active && setHas(value));
    };
    check();
    const unsubscribe = onGenresChanged(check);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [db]);
  return has;
}

/**
 * The Genres tab's button. Its slot is sized by this content (see tabBarItemStyle), and the content's width
 * animates between 0 and one tab's width (a quarter of the bar), so the tab grows in or shrinks away while the
 * other tabs, which share the rest of the bar, slide aside or back. Animated updates the view directly every
 * frame, without re-rendering the tab bar. The first known state (app start) is shown without animating.
 */
function CollapsibleTabButton({ visible, ...props }: BottomTabBarButtonProps & { visible: boolean | null }) {
  const { width: screenWidth } = useWindowDimensions();
  const tabWidth = screenWidth / 4;
  const [size] = useState(() => new Animated.Value(visible ? 1 : 0));
  const settled = useRef(visible !== null);

  useEffect(() => {
    if (visible === null) return;
    if (!settled.current) {
      settled.current = true;
      size.setValue(visible ? 1 : 0);
      return;
    }
    // Width is a layout property, so this runs on the JS side (useNativeDriver cannot animate it).
    Animated.timing(size, {
      toValue: visible ? 1 : 0,
      duration: COLLAPSE_MS,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [visible, size]);

  return (
    <Animated.View
      style={{ width: Animated.multiply(size, tabWidth), opacity: size, overflow: 'hidden' }}
      pointerEvents={visible ? 'auto' : 'none'}
      importantForAccessibility={visible ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!visible}
    >
      {/* Always a full tab wide, so the icon and label are clipped while it grows, never squeezed. */}
      <TabBarButton {...props} style={[props.style, { flex: 0, width: tabWidth }]} />
    </Animated.View>
  );
}

export default function TabLayout() {
  const { t } = useTranslation();
  const showGenres = useHasGenres();
  return (
    <Tabs
      screenOptions={{
        // Every tab is its own Stack with its own (native) header; the tab navigator's
        // JS header is a different height, so it must stay hidden to keep tabs aligned.
        headerShown: false,
        tabBarButton: TabBarButton,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
      }}
    >
      <Tabs.Screen
        name="(queue)"
        options={{
          title: t('tabs.queue'),
          tabBarIcon: ({ color, size }) => <Ionicons name="shuffle" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="artists"
        options={{
          title: t('tabs.artists'),
          // Leaving the tab closes an open artist page, so coming back shows the artist list.
          popToTopOnBlur: true,
          tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="genres"
        options={{
          title: t('tabs.genres'),
          // Only shown once there are genres (from a Spotify or MusicBrainz sync); grows in and shrinks away.
          // The slot takes the width of its (animated) button instead of a share of the bar.
          tabBarItemStyle: { flex: 0 },
          tabBarButton: (props) => <CollapsibleTabButton {...props} visible={showGenres} />,
          tabBarIcon: ({ color, size }) => <Ionicons name="pricetags" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-sharp" color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
