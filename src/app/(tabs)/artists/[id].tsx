import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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

const TYPE_LABEL = {
  album: 'artist.typeAlbum',
  single: 'artist.typeSingle',
  compilation: 'artist.typeCompilation',
} as const;

const isKnownType = (type: string): type is keyof typeof TYPE_LABEL => type in TYPE_LABEL;

/**
 * Fixed heights of the list's parts, so it knows its full length up front (a correct scrollbar from the start).
 * Release header: 24 top + 64 cover + 8 bottom padding; the text beside the cover (2 × 22 + 3 + 17) fits in 64.
 * Song row: 8 + 20 + 2 + 16 + 8.
 */
const ALBUM_HEADER_HEIGHT = 96;
const TRACK_HEIGHT = 54;

export default function ArtistDetailScreen() {
  const { t } = useTranslation();
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
      setName(artist?.name ?? t('artist.unknown'));
      setExcluded(artist?.excluded ?? false);
      setAlbums(discography);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, id, t]);

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
      const count = await generateShuffledQueue(db, filters, { artistId: id });
      if (count === 0) {
        Alert.alert(t('artist.nothingToShuffleTitle'), t('artist.nothingToShuffleText'));
        return;
      }
      router.navigate('/');
    } catch (e) {
      Alert.alert(t('artist.shuffleFailedTitle'), e instanceof Error ? e.message : String(e));
    } finally {
      setShuffling(false);
    }
  };

  const hasSongs = useMemo(() => (albums ?? []).some((a) => a.tracks.length > 0), [albums]);
  const sections = useMemo(() => (albums ?? []).map((album) => ({ album, data: album.tracks })), [albums]);
  // The exclude/shuffle box above the releases wraps differently per language and screen, so it is measured.
  const [listHeaderHeight, setListHeaderHeight] = useState(0);

  /**
   * Position of every list element. The SectionList counts each section as its header, its songs and a
   * (here empty) footer; offsets start below the list header.
   */
  const layouts = useMemo(() => {
    const out: { length: number; offset: number }[] = [];
    let offset = listHeaderHeight;
    for (const section of sections) {
      out.push({ length: ALBUM_HEADER_HEIGHT, offset });
      offset += ALBUM_HEADER_HEIGHT;
      for (let i = 0; i < section.data.length; i++) {
        out.push({ length: TRACK_HEIGHT, offset });
        offset += TRACK_HEIGHT;
      }
      out.push({ length: 0, offset });
    }
    return out;
  }, [sections, listHeaderHeight]);

  return (
    <View style={screen.container}>
      <Stack.Screen options={{ title: name }} />
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        stickySectionHeadersEnabled={false}
        getItemLayout={(_, index) => ({ ...(layouts[index] ?? { length: 0, offset: 0 }), index })}
        contentContainerStyle={{ flexGrow: 1 }}
        ListHeaderComponent={
          excluded === null ? undefined : (
            <View style={screen.header} onLayout={(e) => setListHeaderHeight(e.nativeEvent.layout.height)}>
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
                  <Text style={screen.excludeTitle}>{t('artist.exclude')}</Text>
                  <Text style={screen.excludeHelp}>{t('artist.excludeHelp')}</Text>
                </View>
              </Pressable>
              {hasSongs && (
                <Pressable
                  onPress={shuffleArtist}
                  disabled={shuffling}
                  accessibilityRole="button"
                  accessibilityLabel={t('artist.shuffleLabel', { name })}
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
        ListEmptyComponent={albums ? <EmptyState title={t('artist.noReleases')} /> : undefined}
        renderSectionHeader={({ section: { album } }) => (
          <View style={screen.albumHeader}>
            <Artwork uri={album.image_url} size={64} />
            <View style={{ flex: 1 }}>
              <Text style={screen.albumName} numberOfLines={2}>
                {album.name}
              </Text>
              <Text style={screen.albumMeta}>
                {isKnownType(album.album_type) ? t(TYPE_LABEL[album.album_type]) : album.album_type} ·{' '}
                {album.release_date?.slice(0, 4) ?? '—'} · {countLabel(album.tracks.length, 'song')}
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
  excludePressed: { backgroundColor: colors.highlight },
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
    height: ALBUM_HEADER_HEIGHT,
  },
  albumName: { color: colors.text, fontSize: 17, lineHeight: 22, fontWeight: '700' },
  albumMeta: { color: colors.textMuted, fontSize: 13, lineHeight: 17, marginTop: 3 },
  track: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, height: TRACK_HEIGHT },
  trackNo: { color: colors.textMuted, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  trackName: { color: colors.text, fontSize: 15, lineHeight: 20 },
  trackArtists: { color: colors.textMuted, fontSize: 12, lineHeight: 16, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
