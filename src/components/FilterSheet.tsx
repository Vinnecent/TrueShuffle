import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { ArtistWeighting, ShuffleFilters } from '@/db/queries';
import { colors } from '@/theme';

/** The filters in the order shown; their texts are `filters.<key>` and `filters.<key>Help`. */
export const FILTERS: (keyof ShuffleFilters)[] = [
  'excludeAcoustic',
  'excludeRemix',
  'excludeLive',
  'excludeIntro',
  'excludeInstrumental',
  'preferDeluxe',
];

/** The artist balance options with the keys of their texts. */
export const WEIGHTINGS = [
  { key: 'song', label: 'filters.weightingSong', help: 'filters.weightingSongHelp' },
  { key: 'balanced', label: 'filters.weightingBalanced', help: 'filters.weightingBalancedHelp' },
  { key: 'artist', label: 'filters.weightingArtist', help: 'filters.weightingArtistHelp' },
] as const satisfies readonly { key: ArtistWeighting; label: string; help: string }[];

/** Number of settings changed from their default (filters turned on, plus a non-default weighting). */
export function activeFilterCount(filters: ShuffleFilters, weighting: ArtistWeighting): number {
  return FILTERS.filter((key) => filters[key]).length + (weighting === 'song' ? 0 : 1);
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
  const { t } = useTranslation();
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
      <Pressable style={sheet.backdrop} onPress={onClose} accessibilityLabel={t('filters.close')} />
      <View style={[sheet.panel, { paddingBottom: insets.bottom + 16 }]}>
        <View style={sheet.header}>
          <Text style={sheet.title}>{t('filters.title')}</Text>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
            <Text style={sheet.done}>{t('common.done')}</Text>
          </Pressable>
        </View>
        <View style={sheet.section}>
          <Text style={sheet.sectionLabel}>{t('filters.artistBalance')}</Text>
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
                  <Text style={[sheet.segmentText, selected && sheet.segmentTextSelected]}>{t(label)}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={sheet.help}>{t(WEIGHTINGS.find((w) => w.key === weighting)?.help ?? WEIGHTINGS[0].help)}</Text>
        </View>
        <Text style={[sheet.sectionLabel, { paddingHorizontal: 16, paddingTop: 8 }]}>{t('filters.leaveOut')}</Text>
        {FILTERS.map((key) => {
          const on = filters[key];
          return (
            <Pressable
              key={key}
              onPress={() => onToggle(key)}
              disabled={disabled}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [sheet.row, pressed && { backgroundColor: colors.highlight }]}
            >
              <Ionicons
                name={on ? 'checkbox' : 'square-outline'}
                size={24}
                color={on ? colors.accent : colors.textMuted}
              />
              <View style={{ flex: 1 }}>
                <Text style={sheet.label}>{t(`filters.${key}`)}</Text>
                <Text style={sheet.help}>{t(`filters.${key}Help`)}</Text>
              </View>
            </Pressable>
          );
        })}
        <Text style={sheet.footer}>{t('filters.drawsFrom', { count: shuffleTracks })}</Text>
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
