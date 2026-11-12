import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { activeFilterCount, FilterSheet } from '@/components/FilterSheet';
import { NowPlaying } from '@/components/NowPlaying';
import { QueueItem, type RowLayout } from '@/components/QueueItem';
import { QueueItemMenu, type QueueMenuTarget } from '@/components/QueueItemMenu';
import { Button, EmptyState, styles as ui } from '@/components/ui';
import {
  countShuffleTracks,
  DEFAULT_ARTIST_WEIGHTING,
  DEFAULT_SHUFFLE_FILTERS,
  excludeArtistAndRemoveFromQueue,
  generateShuffledQueue,
  getLibraryStats,
  getQueue,
  getArtistWeighting,
  getExcludableArtistsForTrack,
  getShuffleFilters,
  MAX_QUEUE_SIZE,
  removeFromQueue,
  setArtistWeighting,
  setShuffleFilter,
  type ArtistWeighting,
  type QueueRow,
  type ShuffleFilters,
} from '@/db/queries';
import { ensureLoggedInWithScopes, NotAuthenticatedError } from '@/spotify/auth';
import { useIsPlaying, useSpotifyNowPlaying } from '@/spotify/nowPlaying';
import {
  describePlaybackError,
  openPlaylistInSpotify,
  playSpotifyPlaylist,
  sendToSpotifyPlaylist,
} from '@/spotify/playback';
import { colors } from '@/theme';

/** How long the list gets to scroll a long-pressed row into view before its menu opens. */
const SCROLL_INTO_VIEW_MS = 300;

export default function QueueScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [libraryTracks, setLibraryTracks] = useState<number | null>(null);
  /** Songs the shuffle can draw from (excluded artists and filters applied). */
  const [shuffleTracks, setShuffleTracks] = useState(0);
  const [filters, setFilters] = useState<ShuffleFilters>(DEFAULT_SHUFFLE_FILTERS);
  const [weighting, setWeighting] = useState<ArtistWeighting>(DEFAULT_ARTIST_WEIGHTING);
  const [sending, setSending] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [menu, setMenu] = useState<QueueMenuTarget | null>(null);
  /** Queue position of the row the menu shows a copy of; hidden in the list meanwhile. */
  const [hiddenPosition, setHiddenPosition] = useState<number | null>(null);
  const activeFilters = activeFilterCount(filters, weighting);
  const queueUris = useMemo(() => queue.map((q) => q.uri), [queue]);
  // What Spotify plays, shared by the Now playing card and the list (-1 if it is not in the queue).
  const nowPlaying = useSpotifyNowPlaying();
  const playingIndex = nowPlaying?.trackId ? queueUris.indexOf(nowPlaying.trackId) : -1;
  const isPlaying = useIsPlaying(nowPlaying, playingIndex >= 0 ? queue[playingIndex].duration_ms : null);

  const load = useCallback(async () => {
    const [savedFilters, savedWeighting] = await Promise.all([getShuffleFilters(db), getArtistWeighting(db)]);
    setWeighting(savedWeighting);
    const [rows, stats, eligible] = await Promise.all([
      getQueue(db),
      getLibraryStats(db),
      countShuffleTracks(db, savedFilters),
    ]);
    setQueue(rows);
    setLibraryTracks(stats.tracks);
    setFilters(savedFilters);
    setShuffleTracks(eligible);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const shuffle = async () => {
    setShuffling(true);
    try {
      await generateShuffledQueue(db, filters, { weighting });
      // Only the queue changed; the library, filters and "drawn from" count stay the same.
      setQueue(await getQueue(db));
    } finally {
      setShuffling(false);
    }
  };

  const changeWeighting = async (next: ArtistWeighting) => {
    setWeighting(next);
    await setArtistWeighting(db, next);
  };

  const toggleFilter = async (key: keyof ShuffleFilters) => {
    const next = { ...filters, [key]: !filters[key] };
    setFilters(next);
    await setShuffleFilter(db, key, next[key]);
    setShuffleTracks(await countShuffleTracks(db, next));
  };

  const play = async (playlistId: string) => {
    try {
      await playSpotifyPlaylist(playlistId);
    } catch (e) {
      Alert.alert('Could not start playback', describePlaybackError(e), [
        { text: 'Close', style: 'cancel' },
        { text: 'Open in Spotify', onPress: () => openPlaylistInSpotify(playlistId) },
      ]);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      // Asks for a (re-)login if the stored one predates the playlist permissions.
      await ensureLoggedInWithScopes();
      const playlistId = await sendToSpotifyPlaylist(queueUris);
      Alert.alert(
        'Playlist updated',
        `Your "TrueShuffle" playlist in Spotify now holds ${queue.length === 1 ? 'this song' : `these ${queue.length} songs`}. ` +
          'Play it with Spotify’s shuffle turned off to keep this order.',
        [
          { text: 'Done', style: 'cancel' },
          { text: 'Open in Spotify', onPress: () => openPlaylistInSpotify(playlistId) },
          { text: 'Play now', onPress: () => play(playlistId) },
        ],
      );
    } catch (e) {
      if (e instanceof NotAuthenticatedError) {
        Alert.alert('Not connected', 'Connect your Spotify account on the Settings tab first.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => router.navigate('/settings') },
        ]);
      } else {
        Alert.alert('Could not update the Spotify playlist', describePlaybackError(e));
      }
    } finally {
      setSending(false);
    }
  };

  const listRef = useRef<FlatList<QueueRow>>(null);
  const listFrameRef = useRef<ComponentRef<typeof View>>(null);
  /** Scroll position and sizes of the list, to scroll a long-pressed row fully into view. */
  const scroll = useRef({ offset: 0, contentHeight: 0, viewportHeight: 0 });

  /** The list's visible area in window coordinates. */
  const measureList = () =>
    new Promise<{ top: number; bottom: number } | null>((resolve) => {
      if (!listFrameRef.current) return resolve(null);
      listFrameRef.current.measureInWindow((_x, y, _w, height) => resolve({ top: y, bottom: y + height }));
    });

  const openMenu = async (item: QueueRow, index: number, layout: RowLayout) => {
    const [artists, list] = await Promise.all([getExcludableArtistsForTrack(db, item.track_id), measureList()]);
    // A row partly hidden under the header or tab bar is scrolled fully into view first, so the popped-out
    // copy, which is drawn above everything, returns to a spot that is not covered when the menu closes.
    let rowLayout = layout;
    if (list) {
      const { offset, contentHeight, viewportHeight } = scroll.current;
      const wanted = layout.y < list.top ? layout.y - list.top : Math.max(0, layout.y + layout.height - list.bottom);
      const target = Math.min(Math.max(0, offset + wanted), Math.max(0, contentHeight - viewportHeight));
      const delta = target - offset;
      if (Math.abs(delta) >= 1) {
        listRef.current?.scrollToOffset({ offset: target, animated: true });
        await new Promise((resolve) => setTimeout(resolve, SCROLL_INTO_VIEW_MS));
        rowLayout = { ...layout, y: layout.y - delta };
      }
    }
    const current = index === playingIndex;
    setMenu({ item, index, current, isPlaying: current && isPlaying, layout: rowLayout, artists });
  };

  const remove = async (row: QueueRow) => {
    await removeFromQueue(db, row.position);
    await load();
  };

  const excludeArtist = async (artistId: string) => {
    await excludeArtistAndRemoveFromQueue(db, artistId);
    await load();
  };

  if (libraryTracks === null) return <View style={screen.container} />;

  if (libraryTracks === 0) {
    return (
      <View style={screen.container}>
        <EmptyState title="Your library is empty">
          <Text style={ui.muted}>Add your Spotify Client ID and Secret, then sync your followed artists.</Text>
          <Button title="Go to Settings" onPress={() => router.navigate('/settings')} />
        </EmptyState>
      </View>
    );
  }

  return (
    <View style={screen.container}>
      <View style={screen.header}>
        <NowPlaying state={nowPlaying} queueUris={queueUris} />
        <View style={screen.summaryRow}>
          <Text style={screen.summary}>
            {queue.length} / {MAX_QUEUE_SIZE} songs · drawn from {shuffleTracks.toLocaleString()}
          </Text>
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Filters, ${activeFilters} on`}
            style={({ pressed }) => [
              screen.filterButton,
              activeFilters > 0 && screen.filterButtonOn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="options-outline" size={16} color={activeFilters > 0 ? colors.accent : colors.textMuted} />
            <Text style={[screen.filterButtonText, activeFilters > 0 && { color: colors.text }]}>
              Filters{activeFilters > 0 ? ` · ${activeFilters}` : ''}
            </Text>
          </Pressable>
        </View>
        <View style={screen.actions}>
          <View style={{ flex: 1 }}>
            <Button
              title="Shuffle"
              variant="secondary"
              onPress={shuffle}
              loading={shuffling}
              disabled={sending || shuffleTracks === 0}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Send to Spotify"
              onPress={send}
              loading={sending}
              disabled={queue.length === 0 || shuffling}
            />
          </View>
        </View>
      </View>

      <View ref={listFrameRef} style={{ flex: 1 }} collapsable={false}>
        <FlatList
          ref={listRef}
          data={queue}
          onScroll={(e) => {
            scroll.current.offset = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          onContentSizeChange={(_w, h) => {
            scroll.current.contentHeight = h;
          }}
          onLayout={(e) => {
            scroll.current.viewportHeight = e.nativeEvent.layout.height;
          }}
          keyExtractor={(item) => String(item.position)}
          extraData={`${playingIndex}:${isPlaying}:${hiddenPosition}`}
          contentContainerStyle={{ flexGrow: 1 }}
          ListEmptyComponent={
            shuffleTracks === 0 ? (
              <EmptyState title="Nothing left to shuffle">
                <Text style={ui.muted}>
                  Every song is excluded by an artist exclusion or a filter. Turn a filter off, or include an artist
                  again on the Artists tab.
                </Text>
              </EmptyState>
            ) : (
              <EmptyState title="No songs queued">
                <Text style={ui.muted}>Tap Shuffle to draw {MAX_QUEUE_SIZE} random songs from your library.</Text>
              </EmptyState>
            )
          }
          renderItem={({ item, index }) => (
            <QueueItem
              item={item}
              index={index}
              current={index === playingIndex}
              isPlaying={isPlaying}
              onLongPress={(layout) => openMenu(item, index, layout)}
              // The menu shows a popped-out copy of the row; hide the original meanwhile.
              style={hiddenPosition === item.position && { opacity: 0 }}
            />
          )}
        />
      </View>

      {menu ? (
        <QueueItemMenu
          key={menu.item.position}
          target={menu}
          onRemove={remove}
          onExclude={excludeArtist}
          onPopped={() => setHiddenPosition(menu.item.position)}
          onSettled={() => setHiddenPosition(null)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      <FilterSheet
        visible={filtersOpen}
        filters={filters}
        shuffleTracks={shuffleTracks}
        disabled={shuffling}
        weighting={weighting}
        onToggle={toggleFilter}
        onChangeWeighting={changeWeighting}
        onClose={() => setFiltersOpen(false)}
      />
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { padding: 16, paddingTop: 8, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  summary: { flex: 1, color: colors.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  filterButton: {
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
  filterButtonOn: { borderColor: colors.accent },
  filterButtonText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
});
