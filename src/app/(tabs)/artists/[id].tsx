import { Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';

import { Artwork, EmptyState } from '@/components/ui';
import { getArtist, getArtistDiscography, type AlbumWithTracks } from '@/db/queries';
import { colors, formatDuration } from '@/theme';

const TYPE_LABEL: Record<string, string> = { album: 'Album', single: 'Single / EP', compilation: 'Compilation' };

export default function ArtistDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const [name, setName] = useState('');
  const [albums, setAlbums] = useState<AlbumWithTracks[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [artist, discography] = await Promise.all([getArtist(db, id), getArtistDiscography(db, id)]);
      if (cancelled) return;
      setName(artist?.name ?? 'Unknown artist');
      setAlbums(discography);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  const sections = useMemo(() => (albums ?? []).map((album) => ({ album, data: album.tracks })), [albums]);

  return (
    <View style={screen.container}>
      <Stack.Screen options={{ title: name }} />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1 }}
        ListEmptyComponent={albums ? <EmptyState title="No releases stored for this artist" /> : undefined}
        renderSectionHeader={({ section: { album } }) => (
          <View style={screen.albumHeader}>
            <Artwork uri={album.image_url} size={64} />
            <View style={{ flex: 1 }}>
              <Text style={screen.albumName} numberOfLines={2}>
                {album.name}
              </Text>
              <Text style={screen.albumMeta}>
                {TYPE_LABEL[album.album_type] ?? album.album_type} · {album.release_date?.slice(0, 4) ?? '—'} ·{' '}
                {album.tracks.length} songs
              </Text>
            </View>
          </View>
        )}
        renderItem={({ item }) => (
          <View style={screen.track}>
            <Text style={screen.trackNo}>{item.track_number}</Text>
            <View style={{ flex: 1 }}>
              <Text style={screen.trackName} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={screen.trackArtists} numberOfLines={1}>
                {item.artists}
              </Text>
            </View>
            <Text style={screen.duration}>{formatDuration(item.duration_ms)}</Text>
          </View>
        )}
      />
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  albumHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 8,
  },
  albumName: { color: colors.text, fontSize: 17, fontWeight: '700' },
  albumMeta: { color: colors.textMuted, fontSize: 13, marginTop: 4 },
  track: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 },
  trackNo: { color: colors.textMuted, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  trackName: { color: colors.text, fontSize: 15 },
  trackArtists: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
