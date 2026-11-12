import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ArtistWeighting, ShuffleFilters } from '@/db/queries';
import { colors, countLabel } from '@/theme';

export const FILTERS: { key: keyof ShuffleFilters; label: string; help: string }[] = [
  { key: 'excludeAcoustic', label: 'Exclude acoustic', help: 'Songs with “acoustic” in the title' },
  { key: 'excludeRemix', label: 'Exclude remix', help: 'Songs with “remix” in the title' },
  { key: 'excludeLive', label: 'Exclude live', help: 'Live recordings, e.g. “Song - Live” or “Song (Live at …)”' },
  { key: 'excludeIntro', label: 'Exclude intro songs', help: 'The first song of a release if it is under 1:30' },
  { key: 'excludeInstrumental', label: 'Exclude instrumental', help: 'Songs with “instrumental” in the title' },
  {
    key: 'preferDeluxe',
    label: 'Exclude albums with a deluxe version',
    help: 'Plays only the deluxe version, if it has all of the album’s songs',
  },
];

export const WEIGHTINGS: { key: ArtistWeighting; label: string; help: string }[] = [
  {
    key: 'song',
    label: 'Per song',
    help: 'Every song has the same chance, so artists with many songs come up more often.',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    help: 'Artists with many songs still come up more often, but far less than per song.',
  },
  { key: 'artist', label: 'Per artist', help: 'Every artist has the same chance, however many songs they have.' },
];

/** Number of settings changed from their default (filters turned on, plus a non-default weighting). */
export function activeFilterCount(filters: ShuffleFilters, weighting: ArtistWeighting): number {
  return FILTERS.filter(({ key }) => filters[key]).length + (weighting === 'song' ? 0 : 1);
}

type Props = {
  visible: boolean;
  filters: ShuffleFilters;
  weighting: ArtistWeighting;
  /** Songs the shuffle can draw from with the current filters. */
  shuffleTracks: number;
  disabled?: boolean;
  onToggle: (key: keyof ShuffleFilters) => void;
  onChangeWeighting: (weighting: ArtistWeighting) => void;
  onClose: () => void;
};

/** Bottom sheet with the shuffle filters; changes apply immediately. */
export function FilterSheet({
  visible,
  filters,
  weighting,
  shuffleTracks,
  disabled,
  onToggle,
  onChangeWeighting,
  onClose,
}: Props) {
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
        <View style={sheet.section}>
          <Text style={sheet.sectionLabel}>Artist balance</Text>
          <View style={sheet.segments} accessibilityRole="radiogroup">
            {WEIGHTINGS.map(({ key, label }) => {
              const selected = weighting === key;
              return (
                <Pressable
                  key={key}
                  onPress={() => onChangeWeighting(key)}
                  disabled={disabled}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: selected }}
                  style={({ pressed }) => [
                    sheet.segment,
                    selected && sheet.segmentSelected,
                    pressed && !selected && { opacity: 0.7 },
                  ]}
                >
                  <Text style={[sheet.segmentText, selected && sheet.segmentTextSelected]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={sheet.help}>{WEIGHTINGS.find((w) => w.key === weighting)?.help}</Text>
        </View>
        <Text style={[sheet.sectionLabel, { paddingHorizontal: 16, paddingTop: 8 }]}>Leave out</Text>
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
  section: { paddingHorizontal: 16, paddingBottom: 8, gap: 8 },
  sectionLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  segments: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8 },
  segmentSelected: { backgroundColor: colors.accent },
  segmentText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  segmentTextSelected: { color: colors.accentText },
  footer: { color: colors.textMuted, fontSize: 13, paddingHorizontal: 16, paddingTop: 12 },
});
