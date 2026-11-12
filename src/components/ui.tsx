import { Image } from 'expo-image';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/theme';

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
};

export function Button({ title, onPress, variant = 'primary', disabled, loading }: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'danger' && styles.dangerButton,
        (pressed || inactive) && { opacity: inactive ? 0.5 : 0.8 },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'primary' ? colors.accentText : colors.text} />
      ) : (
        <Text style={[styles.buttonText, variant === 'primary' && { color: colors.accentText }]}>{title}</Text>
      )}
    </Pressable>
  );
}

export function Artwork({
  uri,
  size = 48,
  round,
  fadeIn = true,
  onDisplay,
}: {
  uri: string | null;
  size?: number;
  round?: boolean;
  /** Fade the picture in once loaded; off where it replaces a copy that is already on screen. */
  fadeIn?: boolean;
  /** Called once the picture is on screen. */
  onDisplay?: () => void;
}) {
  const style = { width: size, height: size, borderRadius: round ? size / 2 : 4 };
  return uri ? (
    // Cached in memory and on disk: artwork is downloaded once, then loads from storage.
    // recyclingKey clears the old picture right away when a list row is reused for another item.
    <Image
      source={uri}
      style={[style, styles.artwork]}
      contentFit="cover"
      cachePolicy="memory-disk"
      recyclingKey={uri}
      transition={fadeIn ? 150 : 0}
      onDisplay={onDisplay}
    />
  ) : (
    <View style={[style, styles.artwork]} />
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {children}
    </View>
  );
}

export const styles = StyleSheet.create({
  button: {
    minHeight: 46,
    paddingHorizontal: 20,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent },
  secondary: { backgroundColor: colors.surfaceRaised },
  dangerButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.danger },
  buttonText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  artwork: { backgroundColor: colors.surfaceRaised },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  muted: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
});
