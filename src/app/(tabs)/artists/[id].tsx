import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { Artwork, EmptyState } from '@/components/ui';
import {
  generateShuffledQueue,
  getArtist,
  getArtistDiscography,
  getShuffleFilters,
  setArtistExcluded,
  type AlbumWithTracks,
} from '@/db/queries';
import { colors, countLabel, formatDuration } from '@/theme';

const TYPE_LABEL: Record<string, string> = { album: 'Album', single: 'Single / EP', compilation: 'Compilation' };

export default function ArtistDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const db = useSQLiteContext();
  const router = useRouter();
  const [name, setName] = useState('');
  const [albums, setAlbums] = useState<AlbumWithTracks[] | null>(null);
  const [excluded, setExcluded] = useState<boolean | null>(null);
  const [shuffling, setShuffling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [artist, discography] = await Promise.all([getArtist(db, id), getArtistDiscography(db, id)]);
      if (cancelled) return;
      setName(artist?.name ?? 'Unknown artist');
      setExcluded(artist?.excluded ?? false);
      setAlbums(discography);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id]);

  const toggleExcluded = async () => {
    if (excluded === null) return;
    const next = !excluded;
    setExcluded(next);
    try {
      await setArtistExcluded(db, id, next);
    } catch {
      setExcluded(!next);
    }
  };

  /** Builds the queue from this artist's songs only (with the Queue tab's filters), then opens the Queue tab. */
  const shuffleArtist = async () => {
    setShuffling(true);
    try {
      const filters = await getShuffleFilters(db);
      const count = await generateShuffledQueue(db, filters, id);
      if (count === 0) {
        Alert.alert('Nothing to shuffle', 'Your filters on the Queue tab remove every song by this artist.');
        return;
      }
      router.navigate('/');
    } catch (e) {
      Alert.alert('Could not shuffle', e instanceof Error ? e.message : String(e));
    } finally {
      setShuffling(false);
    }
  };

  const hasSongs = useMemo(() => (albums ?? []).some((a) => a.tracks.length > 0), [albums]);
  const sections = useMemo(() => (albums ?? []).map((album) => ({ album, data: album.tracks })), [albums]);

  return (
    <View style={screen.container}>
      <Stack.Screen options={{ title: name }} />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ flexGrow: 1 }}
        ListHeaderComponent={
          excluded === null ? undefined : (
            <View style={screen.header}>
              <Pressable
                onPress={toggleExcluded}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: excluded }}
                style={({ pressed }) => [screen.exclude, pressed && screen.excludePressed]}
              >
                <Ionicons
                  name={excluded ? 'checkbox' : 'square-outline'}
                  size={24}
                  color={excluded ? colors.accent : colors.textMuted}
                />
                <View style={{ flex: 1 }}>
                  <Text style={screen.excludeTitle}>Exclude from shuffle</Text>
                  <Text style={screen.excludeHelp}>
                    Songs from releases shared with another artist you follow can still be picked.
                  </Text>
                </View>
              </Pressable>
              {hasSongs && (
                <Pressable
                  onPress={shuffleArtist}
                  disabled={shuffling}
                  accessibilityRole="button"
                  accessibilityLabel={`Shuffle songs by ${name}`}
                  style={({ pressed }) => [screen.shuffle, pressed && screen.shufflePressed]}
                >
                  {shuffling ? (
                    <ActivityIndicator color={colors.accentText} />
                  ) : (
                    <Ionicons name="shuffle" size={28} color={colors.accentText} />
                  )}
                </Pressable>
              )}
            </View>
          )
        }
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
                {countLabel(album.tracks.length, 'song')}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 8 },
  exclude: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: colors.surface,
  },
  excludePressed: { backgroundColor: colors.surfaceRaised },
  shuffle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  shufflePressed: { opacity: 0.8 },
  excludeTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  excludeHelp: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
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
