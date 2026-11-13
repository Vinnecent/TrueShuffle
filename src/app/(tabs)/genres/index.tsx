import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { EmptyState } from '@/components/ui';
import { generateShuffledQueue, getArtistWeighting, getGenres, getShuffleFilters, type GenreRow } from '@/db/queries';
import { colors, countLabel } from '@/theme';

/** Fixed row height, so the list knows its full length up front (a correct scrollbar from the start). */
const ROW_HEIGHT = 64;

const getItemLayout = (_: ArrayLike<GenreRow> | null | undefined, index: number) => ({
  length: ROW_HEIGHT,
  offset: ROW_HEIGHT * index,
  index,
});

/** Genres are stored in lower case; shown with a capital first letter ("Nu metal"). */
const displayName = (genre: string) => genre.charAt(0).toUpperCase() + genre.slice(1);

export default function GenresScreen() {
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const router = useRouter();
  const [genres, setGenres] = useState<GenreRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [shuffling, setShuffling] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      getGenres(db).then(setGenres);
    }, [db]),
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (genres ?? []).filter((g) => !q || g.genre.includes(q));
  }, [genres, filter]);

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
      <FlatList
        data={visible}
        keyExtractor={(g) => g.genre}
        getItemLayout={getItemLayout}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1 }}
        ListEmptyComponent={<EmptyState title={t('genres.noMatches')} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => shuffle(item.genre)}
            disabled={shuffling !== null}
            accessibilityRole="button"
            accessibilityLabel={t('genres.shuffleLabel', { genre: displayName(item.genre) })}
            style={({ pressed }) => [screen.row, pressed && { backgroundColor: colors.highlight }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={screen.name} numberOfLines={1}>
                {displayName(item.genre)}
              </Text>
              <Text style={screen.meta} numberOfLines={1}>
                {countLabel(item.artists, 'artist')} · {countLabel(item.songs, 'song')}
              </Text>
            </View>
            <View style={screen.shuffle}>
              {shuffling === item.genre ? (
                <ActivityIndicator size="small" color={colors.accentText} />
              ) : (
                <Ionicons name="shuffle" size={20} color={colors.accentText} />
              )}
            </View>
          </Pressable>
        )}
      />
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    height: ROW_HEIGHT,
  },
  name: { color: colors.text, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 13, lineHeight: 17, marginTop: 2 },
  shuffle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
});
