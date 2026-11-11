import { Link, useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
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
  const db = useSQLiteContext();
  const router = useRouter();
  const [artists, setArtists] = useState<ArtistRow[] | null>(null);
  const [filter, setFilter] = useState('');

  useFocusEffect(
    useCallback(() => {
      getArtists(db).then(setArtists);
    }, [db]),
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = artists ?? [];
    return q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all;
  }, [artists, filter]);

  if (artists === null) return <View style={screen.container} />;

  if (artists.length === 0) {
    return (
      <View style={screen.container}>
        <EmptyState title="No artists yet">
          <Text style={ui.muted}>Add your Spotify Client ID and Secret, then sync your followed artists.</Text>
          <Button title="Go to Settings" onPress={() => router.navigate('/settings')} />
        </EmptyState>
      </View>
    );
  }

  return (
    <View style={screen.container}>
      <TextInput
        value={filter}
        onChangeText={setFilter}
        placeholder={`Search ${countLabel(artists.length, 'artist')}`}
        placeholderTextColor={colors.textMuted}
        style={screen.search}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <FlatList
        data={visible}
        keyExtractor={(a) => a.id}
        getItemLayout={getItemLayout}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ flexGrow: 1 }}
        ListEmptyComponent={<EmptyState title="No matching artists" />}
        renderItem={({ item }) => (
          <Link href={{ pathname: '/artists/[id]', params: { id: item.id } }} asChild>
            <Pressable style={screen.row}>
              <Artwork uri={item.image_url} size={52} round />
              <View style={{ flex: 1, opacity: item.excluded ? 0.5 : 1 }}>
                <Text style={screen.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={screen.meta} numberOfLines={1}>
                  {countLabel(item.album_count, 'release')} · {countLabel(item.track_count, 'song')}
                  {item.excluded ? ' · Excluded from shuffle' : ''}
                </Text>
              </View>
            </Pressable>
          </Link>
        )}
      />
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  search: {
    margin: 16,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    fontSize: 15,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, height: ROW_HEIGHT },
  name: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
});
