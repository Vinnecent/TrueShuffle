import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { activeFilterCount, FilterSheet } from '@/components/FilterSheet';
import { NowPlaying } from '@/components/NowPlaying';
import { QUEUE_ROW_HEIGHT, QueueItem, type RowLayout } from '@/components/QueueItem';
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
  getArtistsForTrack,
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
  getPlaylistHoldingQueue,
  openPlaylistInSpotify,
  playSpotifyPlaylist,
  sendToSpotifyPlaylist,
} from '@/spotify/playback';
import { colors } from '@/theme';

/** Every row has the same height, so the list can place all rows (and size its scrollbar) without measuring them. */
const getItemLayout = (_: ArrayLike<QueueRow> | null | undefined, index: number) => ({
  length: QUEUE_ROW_HEIGHT,
  offset: QUEUE_ROW_HEIGHT * index,
  index,
});

/** How long the list gets to scroll a long-pressed row into view before its menu opens. */
const SCROLL_INTO_VIEW_MS = 300;

export default function QueueScreen() {
  const { t } = useTranslation();
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
  /**
   * From the long press until the menu has closed. The list must not scroll by touch meanwhile: the finger that
   * started the long press still belongs to the list and would otherwise scroll it under the menu.
   */
  const [menuActive, setMenuActive] = useState(false);
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
      Alert.alert(t('queue.playbackFailedTitle'), describePlaybackError(e), [
        { text: t('common.close'), style: 'cancel' },
        { text: t('common.openInSpotify'), onPress: () => openPlaylistInSpotify(playlistId) },
      ]);
    }
  };

  const send = async () => {
    setSending(true);
    try {
      const buttons = (playlistId: string) => [
        { text: t('common.done'), style: 'cancel' as const },
        { text: t('common.openInSpotify'), onPress: () => openPlaylistInSpotify(playlistId) },
        { text: t('queue.playNow'), onPress: () => play(playlistId) },
      ];
      // This exact queue was already sent: no need to spend Spotify requests on sending it again.
      const holding = await getPlaylistHoldingQueue(db, queueUris);
      if (holding) {
        Alert.alert(t('queue.alreadySentTitle'), t('queue.alreadySentText'), buttons(holding));
        return;
      }
      // Asks for a (re-)login if the stored one predates the playlist permissions.
      await ensureLoggedInWithScopes();
      const playlistId = await sendToSpotifyPlaylist(db, queueUris);
      Alert.alert(
        t('queue.playlistUpdatedTitle'),
        t('queue.playlistUpdatedText', { count: queue.length }),
        buttons(playlistId),
      );
    } catch (e) {
      if (e instanceof NotAuthenticatedError) {
        Alert.alert(t('queue.notConnectedTitle'), t('queue.notConnectedText'), [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('queue.openSettings'), onPress: () => router.navigate('/settings') },
        ]);
      } else {
        Alert.alert(t('queue.sendFailedTitle'), describePlaybackError(e));
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
    setMenuActive(true);
    const [artists, list] = await Promise.all([getArtistsForTrack(db, item.track_id), measureList()]);
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

  /** Replaces the queue with this artist's songs only (the filters apply), like Shuffle on the artist page. */
  const shuffleArtist = async (artistId: string) => {
    const count = await generateShuffledQueue(db, filters, { artistId });
    if (count === 0) {
      Alert.alert(t('artist.nothingToShuffleTitle'), t('artist.nothingToShuffleText'));
      return;
    }
    setQueue(await getQueue(db));
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  };

  if (libraryTracks === null) return <View style={screen.container} />;

  if (libraryTracks === 0) {
    return (
      <View style={screen.container}>
        <EmptyState title={t('queue.emptyLibraryTitle')}>
          <Text style={ui.muted}>{t('queue.emptyLibraryText')}</Text>
          <Button title={t('common.goToSettings')} onPress={() => router.navigate('/settings')} />
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
            {t('queue.summary', { queued: queue.length, max: MAX_QUEUE_SIZE, eligible: shuffleTracks })}
          </Text>
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('queue.filtersLabel', { count: activeFilters })}
            style={({ pressed }) => [
              screen.filterButton,
              activeFilters > 0 && screen.filterButtonOn,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Ionicons name="options-outline" size={16} color={activeFilters > 0 ? colors.accent : colors.textMuted} />
            <Text style={[screen.filterButtonText, activeFilters > 0 && { color: colors.text }]}>
              {activeFilters > 0 ? t('queue.filtersCount', { count: activeFilters }) : t('queue.filters')}
            </Text>
          </Pressable>
        </View>
        <View style={screen.actions}>
          <View style={{ flex: 1 }}>
            <Button
              title={t('queue.shuffle')}
              variant="secondary"
              onPress={shuffle}
              loading={shuffling}
              disabled={sending || shuffleTracks === 0}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={t('queue.sendToSpotify')}
              onPress={send}
              loading={sending}
              disabled={queue.length === 0 || shuffling}
            />
          </View>
        </View>
      </View>

      <View ref={listFrameRef} style={{ flex: 1, paddingHorizontal: 8 }} collapsable={false}>
        <FlatList
          ref={listRef}
          getItemLayout={getItemLayout}
          // Scrolling by code (a row into view) still works while touch scrolling is off.
          scrollEnabled={!menuActive}
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
              <EmptyState title={t('queue.nothingLeftTitle')}>
                <Text style={ui.muted}>{t('queue.nothingLeftText')}</Text>
              </EmptyState>
            ) : (
              <EmptyState title={t('queue.noSongsTitle')}>
                <Text style={ui.muted}>{t('queue.noSongsText', { count: MAX_QUEUE_SIZE })}</Text>
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
              hidden={hiddenPosition === item.position}
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
          onShuffleArtist={shuffleArtist}
          onPopped={() => setHiddenPosition(menu.item.position)}
          onSettled={() => setHiddenPosition(null)}
          onClose={() => {
            setMenu(null);
            setMenuActive(false);
          }}
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
