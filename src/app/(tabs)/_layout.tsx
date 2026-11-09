import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, type BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { PlatformPressable } from 'expo-router/react-navigation';

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
      android_ripple={{ borderless: false, foreground: true, color: 'rgba(255, 255, 255, 0.12)' }}
    />
  );
}

export default function TabLayout() {
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
          title: 'Queue',
          tabBarIcon: ({ color, size }) => <Ionicons name="shuffle" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="artists"
        options={{
          title: 'Artists',
          tabBarIcon: ({ color, size }) => <Ionicons name="people" color={color as string} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings-sharp" color={color as string} size={size} />,
        }}
      />
    </Tabs>
  );
}
