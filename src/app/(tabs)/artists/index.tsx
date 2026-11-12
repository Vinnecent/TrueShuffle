import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Artwork, Button, EmptyState, styles as ui } from '@/components/ui';
import { getArtists, type ArtistRow } from '@/db/queries';
import { colors, countLabel } from '@/theme';

/** Fixed height of an artist row (52pt cover + 2×8pt padding), so the list knows its full length up front. */
const ROW_HEIGHT = 68;

/** Every row has the same height, so the list can place all rows (and size its scrollbar) without measuring them. */
const getItemLayout = (_: ArrayLike<ArtistRow> | null | undefined, index: number) => ({
  length: ROW_HEIGHT,
  offset: ROW_HEIGHT * index,
  index,
});

export default function ArtistsScreen() {
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const router = useRouter();
  const [artists, setArtists] = useState<ArtistRow[] | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyExcluded, setOnlyExcluded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      getArtists(db).then(setArtists);
    }, [db]),
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (artists ?? []).filter((a) => (!onlyExcluded || a.excluded) && (!q || a.name.toLowerCase().includes(q)));
  }, [artists, filter, onlyExcluded]);
  const excludedCount = useMemo(() => (artists ?? []).filter((a) => a.excluded).length, [artists]);

  if (artists === null) return <View style={screen.container} />;

  if (artists.length === 0) {
    return (
      <View style={screen.container}>
        <EmptyState title={t('artists.emptyTitle')}>
          <Text style={ui.muted}>{t('artists.emptyText')}</Text>
          <Button title={t('common.goToSettings')} onPress={() => router.navigate('/settings')} />
        </EmptyState>
      </View>
    );
  }

  return (
    <View style={screen.container}>
      <View style={screen.toolbar}>
        <TextInput
          value={filter}
          onChangeText={setFilter}
          placeholder={
            onlyExcluded
              ? t('artists.search', { what: countLabel(excludedCount, 'excludedArtist') })
              : t('artists.search', { what: countLabel(artists.length, 'artist') })
          }
          placeholderTextColor={colors.textMuted}
          style={screen.search}
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <Pressable
          onPress={() => setOnlyExcluded((on) => !on)}
          accessibilityRole="switch"
          accessibilityState={{ checked: onlyExcluded }}
          accessibilityLabel={t('artists.excludedButtonLabel', { count: excludedCount })}
          style={({ pressed }) => [
            screen.excludedButton,
            onlyExcluded && screen.excludedButtonOn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Ionicons name="ban-outline" size={16} color={onlyExcluded ? colors.accent : colors.textMuted} />
          <Text style={[screen.excludedButtonText, onlyExcluded && { color: colors.text }]}>
            {t('artists.excludedButton', { count: excludedCount })}
          </Text>
        </Pressable>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(a) => a.id}
        getItemLayout={getItemLayout}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1 }}
        ListEmptyComponent={
          onlyExcluded && excludedCount === 0 ? (
            <EmptyState title={t('artists.noExcludedTitle')}>
              <Text style={ui.muted}>{t('artists.noExcludedText')}</Text>
            </EmptyState>
          ) : (
            <EmptyState title={t('artists.noMatches')} />
          )
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push({ pathname: '/artists/[id]', params: { id: item.id } })}
            style={({ pressed }) => [screen.row, pressed && { backgroundColor: colors.highlight }]}
          >
            <Artwork uri={item.image_url} size={52} round />
            <View style={{ flex: 1, opacity: item.excluded ? 0.5 : 1 }}>
              <Text style={screen.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={screen.meta} numberOfLines={1}>
                {countLabel(item.album_count, 'release')} · {countLabel(item.track_count, 'song')}
                {item.excluded ? ` · ${t('artists.excludedFromShuffle')}` : ''}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 8, marginBottom: 8 },
  search: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    fontSize: 15,
  },
  excludedButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  excludedButtonOn: { borderColor: colors.accent },
  excludedButtonText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, height: ROW_HEIGHT },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
});
