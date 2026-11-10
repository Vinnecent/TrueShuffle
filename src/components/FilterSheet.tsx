import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ShuffleFilters } from '@/db/queries';
import { colors, countLabel } from '@/theme';

export const FILTERS: { key: keyof ShuffleFilters; label: string; help: string }[] = [
  { key: 'excludeAcoustic', label: 'Exclude acoustic', help: 'Songs with “acoustic” in the title' },
  { key: 'excludeRemix', label: 'Exclude remix', help: 'Songs with “remix” in the title' },
  { key: 'excludeLive', label: 'Exclude live', help: 'Live recordings, e.g. “Song - Live” or “Song (Live at …)”' },
  { key: 'excludeIntro', label: 'Exclude intro songs', help: 'The first song of a release if it is under 1:30' },
  { key: 'excludeInstrumental', label: 'Exclude instrumental', help: 'Songs with “instrumental” in the title' },
];

/** Number of filters turned on. */
export function activeFilterCount(filters: ShuffleFilters): number {
  return FILTERS.filter(({ key }) => filters[key]).length;
}

type Props = {
  visible: boolean;
  filters: ShuffleFilters;
  /** Songs the shuffle can draw from with the current filters. */
  shuffleTracks: number;
  disabled?: boolean;
  onToggle: (key: keyof ShuffleFilters) => void;
  onClose: () => void;
};

/** Bottom sheet with the shuffle filters; changes apply immediately. */
export function FilterSheet({ visible, filters, shuffleTracks, disabled, onToggle, onClose }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={sheet.backdrop} onPress={onClose} accessibilityLabel="Close filters" />
      <View style={[sheet.panel, { paddingBottom: insets.bottom + 16 }]}>
        <View style={sheet.header}>
          <Text style={sheet.title}>Shuffle filters</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={sheet.done}>Done</Text>
          </Pressable>
        </View>
        {FILTERS.map(({ key, label, help }) => {
          const on = filters[key];
          return (
            <Pressable
              key={key}
              onPress={() => onToggle(key)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [sheet.row, pressed && { backgroundColor: colors.surfaceRaised }]}
            >
              <Ionicons
                name={on ? 'checkbox' : 'square-outline'}
                size={24}
                color={on ? colors.accent : colors.textMuted}
              />
              <View style={{ flex: 1 }}>
                <Text style={sheet.label}>{label}</Text>
                <Text style={sheet.help}>{help}</Text>
              </View>
            </Pressable>
          );
        })}
        <Text style={sheet.footer}>Shuffle draws from {countLabel(shuffleTracks, 'song')}</Text>
      </View>
    </Modal>
  );
}

const sheet = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.6)' },
  panel: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingTop: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { color: colors.text, fontSize: 17, fontWeight: '700' },
  done: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  label: { color: colors.text, fontSize: 15, fontWeight: '600' },
  help: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  footer: { color: colors.textMuted, fontSize: 13, paddingHorizontal: 16, paddingTop: 12 },
});
