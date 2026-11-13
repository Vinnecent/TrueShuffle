import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { EmptyState } from '@/components/ui';
import { generateShuffledQueue, getArtistWeighting, getGenres, getShuffleFilters, type GenreRow } from '@/db/queries';
import { colors, countLabel, formatNumber } from '@/theme';

/** Genres are stored in lower case; shown with a capital first letter ("Nu metal"). */
const displayName = (genre: string) => genre.charAt(0).toUpperCase() + genre.slice(1);

/** Space between chips, horizontally and between lines. */
const CHIP_GAP = 8;
const CHIP_HEIGHT = 38;
/** How long chips take to move, appear or disappear when the search changes. */
const CHIP_ANIMATION_MS = 200;
/** How many of the following chips may move up to fill the end of a line. */
const LOOKAHEAD = 16;

/** What a chip's width depends on: its name and its formatted count. */
const widthKey = (g: GenreRow) => `${g.genre}\u0000${formatNumber(g.songs)}`;

/**
 * Splits the chips into lines that fill the width well, keeping roughly the order of `items` (most songs first):
 * a line takes the chips in order, and when the next one does not fit, the following LOOKAHEAD chips may move up
 * to fill the gap. Returns null until every chip's width is known.
 */
function packLines(items: GenreRow[], widthOf: (g: GenreRow) => number | undefined, maxWidth: number) {
  const remaining = [...items];
  const lines: GenreRow[][] = [];
  while (remaining.length > 0) {
    const line: GenreRow[] = [];
    let used = 0;
    for (let i = 0; i < remaining.length && i < LOOKAHEAD + line.length;) {
      const measured = widthOf(remaining[i]);
      if (measured === undefined) return null;
      const width = Math.min(measured, maxWidth);
      const needed = line.length === 0 ? width : used + CHIP_GAP + width;
      if (needed <= maxWidth) {
        line.push(remaining[i]);
        used = needed;
        remaining.splice(i, 1);
      } else {
        i++;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A genre's name and song count; the same in the visible chips and the hidden ones that are measured. */
function ChipLabel({ item, busy }: { item: GenreRow; busy?: boolean }) {
  return (
    <>
      <Text style={screen.chipName} numberOfLines={1}>
        {displayName(item.genre)}
      </Text>
      <View>
        {/* The count keeps its space while the spinner shows, so the chip does not change width. */}
        <Text style={[screen.chipCount, busy && { opacity: 0 }]}>{formatNumber(item.songs)}</Text>
        {busy && <ActivityIndicator size="small" color={colors.accent} style={screen.chipSpinner} />}
      </View>
    </>
  );
}

/** Where a chip sits in the chip layer. */
type Spot = { x: number; y: number };

type ChipProps = {
  item: GenreRow;
  /** Its place, or null while it does not match the search (it then fades out where it was). */
  spot: Spot | null;
  width: number;
  busy: boolean;
  disabled: boolean;
  label: string;
  onPress: (genre: string) => void;
};

/**
 * A chip positioned in the chip layer. It glides to a new spot, fades and shrinks away when it stops matching
 * the search, and fades and grows in (at its new spot) when it matches again. Position, opacity and size are
 * animated natively (transform and opacity), so typing in the search stays smooth.
 */
const AnimatedChip = memo(function AnimatedChip({ item, spot, width, busy, disabled, label, onPress }: ChipProps) {
  const [position] = useState(() => new Animated.ValueXY(spot ?? { x: 0, y: 0 }));
  const [shown] = useState(() => new Animated.Value(spot ? 1 : 0));
  const wasShown = useRef(spot !== null);
  const x = spot?.x;
  const y = spot?.y;

  useEffect(() => {
    const timing = { duration: CHIP_ANIMATION_MS, easing: Easing.out(Easing.quad), useNativeDriver: true };
    if (x === undefined || y === undefined) {
      wasShown.current = false;
      Animated.timing(shown, { toValue: 0, ...timing }).start();
      return;
    }
    // A chip that comes back appears at its new spot instead of flying in from where it disappeared.
    if (!wasShown.current) position.setValue({ x, y });
    wasShown.current = true;
    Animated.parallel([
      Animated.timing(position, { toValue: { x, y }, ...timing }),
      Animated.timing(shown, { toValue: 1, ...timing }),
    ]).start();
  }, [x, y, position, shown]);

  const scale = shown.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] });
  return (
    <Animated.View
      style={[
        screen.chipSlot,
        { width, opacity: shown, transform: [{ translateX: position.x }, { translateY: position.y }, { scale }] },
      ]}
      pointerEvents={spot ? 'auto' : 'none'}
      importantForAccessibility={spot ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!spot}
    >
      <Pressable
        onPress={() => onPress(item.genre)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [
          screen.chip,
          (pressed || busy) && { backgroundColor: colors.highlight },
          busy && { borderColor: colors.accent },
        ]}
      >
        <ChipLabel item={item} busy={busy} />
      </Pressable>
    </Animated.View>
  );
});

export default function GenresScreen() {
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const router = useRouter();
  const [genres, setGenres] = useState<GenreRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [shuffling, setShuffling] = useState<string | null>(null);
  /** Width available for a line of chips. */
  const [lineWidth, setLineWidth] = useState(0);
  /** Measured chip widths, by widthKey. */
  const [chipWidths, setChipWidths] = useState<Record<string, number>>({});

  useFocusEffect(
    useCallback(() => {
      getGenres(db).then(setGenres);
    }, [db]),
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (genres ?? []).filter((g) => !q || g.genre.includes(q));
  }, [genres, filter]);

  const unmeasured = useMemo(
    () => (genres ?? []).filter((g) => chipWidths[widthKey(g)] === undefined),
    [genres, chipWidths],
  );

  /** Every matching chip's spot: packed lines, each centred, one below the other. */
  const layout = useMemo(() => {
    const spots = new Map<string, Spot>();
    const lines = lineWidth > 0 ? packLines(visible, (g) => chipWidths[widthKey(g)], lineWidth) : null;
    lines?.forEach((line, index) => {
      const widths = line.map((g) => Math.min(chipWidths[widthKey(g)], lineWidth));
      const used = widths.reduce((sum, w) => sum + w, 0) + CHIP_GAP * (line.length - 1);
      let x = (lineWidth - used) / 2;
      line.forEach((g, i) => {
        spots.set(g.genre, { x, y: index * (CHIP_HEIGHT + CHIP_GAP) });
        x += widths[i] + CHIP_GAP;
      });
    });
    const height = lines && lines.length > 0 ? lines.length * (CHIP_HEIGHT + CHIP_GAP) - CHIP_GAP : 0;
    return { spots, height };
  }, [visible, chipWidths, lineWidth]);

  /** Replaces the queue with songs of this genre's artists (filters and artist balance apply), then shows it. */
  const shuffle = async (genre: string) => {
    setShuffling(genre);
    try {
      const [filters, weighting] = await Promise.all([getShuffleFilters(db), getArtistWeighting(db)]);
      const count = await generateShuffledQueue(db, filters, { genre, weighting });
      if (count === 0) {
        Alert.alert(t('genres.nothingToShuffleTitle'), t('genres.nothingToShuffleText'));
        return;
      }
      router.navigate('/');
    } catch (e) {
      Alert.alert(t('genres.shuffleFailedTitle'), (e as Error).message);
    } finally {
      setShuffling(null);
    }
  };

  if (genres === null) return <View style={screen.container} />;

  return (
    <View style={screen.container}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder={t('genres.search', { what: countLabel(genres.length, 'genre') })}
        placeholderTextColor={colors.textMuted}
        style={screen.search}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />

      {/* Invisible copies of the chips not measured yet, at their natural width, to plan the lines. */}
      {unmeasured.length > 0 && (
        <View style={screen.measure} pointerEvents="none" importantForAccessibility="no-hide-descendants">
          {unmeasured.map((item) => (
            <View
              key={widthKey(item)}
              style={screen.chip}
              onLayout={(e) => {
                const width = e.nativeEvent.layout.width;
                setChipWidths((w) => (w[widthKey(item)] === width ? w : { ...w, [widthKey(item)]: width }));
              }}
            >
              <ChipLabel item={item} />
            </View>
          ))}
        </View>
      )}

      <ScrollView contentContainerStyle={screen.content} keyboardShouldPersistTaps="handled">
        {visible.length === 0 ? (
          <EmptyState title={t('genres.noMatches')} />
        ) : (
          <Text style={screen.hint}>{t('genres.hint')}</Text>
        )}
        {/* All chips in one layer at packed, centred spots (most songs first); one tap shuffles that genre.
            Chips that do not match the search stay mounted, faded out, so they can animate back in. */}
        <View style={{ height: layout.height }} onLayout={(e) => setLineWidth(e.nativeEvent.layout.width)}>
          {genres.map((item) => (
            <AnimatedChip
              key={item.genre}
              item={item}
              spot={layout.spots.get(item.genre) ?? null}
              width={Math.min(chipWidths[widthKey(item)] ?? 0, lineWidth)}
              busy={shuffling === item.genre}
              disabled={shuffling !== null}
              label={`${t('genres.shuffleLabel', { genre: displayName(item.genre) })}, ${countLabel(item.songs, 'song')}`}
              onPress={shuffle}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  search: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    fontSize: 15,
  },
  content: { flexGrow: 1, paddingHorizontal: 16, paddingBottom: 24 },
  hint: { color: colors.textMuted, fontSize: 13, marginBottom: 12 },
  // Chips are placed by transform from the top left of the chip layer.
  chipSlot: { position: 'absolute', top: 0, left: 0 },
  // Off screen and invisible; each chip takes its natural width there.
  measure: { position: 'absolute', top: 0, left: 0, opacity: 0, alignItems: 'flex-start' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
    paddingHorizontal: 14,
    height: CHIP_HEIGHT,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipName: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  chipCount: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
  chipSpinner: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, transform: [{ scale: 0.7 }] },
});
