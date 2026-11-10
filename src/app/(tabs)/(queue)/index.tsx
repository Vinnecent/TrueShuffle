import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { NowPlaying } from '@/components/NowPlaying';
import { Artwork, Button, EmptyState, styles as ui } from '@/components/ui';
import {
  countShuffleTracks,
  DEFAULT_SHUFFLE_FILTERS,
  generateShuffledQueue,
  getLibraryStats,
  getQueue,
  getShuffleFilters,
  MAX_QUEUE_SIZE,
  removeFromQueue,
  setShuffleFilter,
  type QueueRow,
  type ShuffleFilters,
} from '@/db/queries';
import { ensureLoggedInWithScopes, NotAuthenticatedError } from '@/spotify/auth';
import {
  describePlaybackError,
  openPlaylistInSpotify,
  playSpotifyPlaylist,
  sendToSpotifyPlaylist,
} from '@/spotify/playback';
import { colors, formatDuration } from '@/theme';

const FILTERS: { key: keyof ShuffleFilters; label: string }[] = [
  { key: 'excludeAcoustic', label: 'Exclude acoustic' },
  { key: 'excludeRemix', label: 'Exclude remix' },
  { key: 'excludeLive', label: 'Exclude live' },
  { key: 'excludeIntro', label: 'Exclude intro songs' },
  { key: 'excludeInstrumental', label: 'Exclude instrumental' },
];

export default function QueueScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [libraryTracks, setLibraryTracks] = useState<number | null>(null);
  /** Songs the shuffle can draw from (excluded artists and filters applied). */
  const [shuffleTracks, setShuffleTracks] = useState(0);
  const [filters, setFilters] = useState<ShuffleFilters>(DEFAULT_SHUFFLE_FILTERS);
  const [sending, setSending] = useState(false);
  const [shuffling, setShuffling] = useState(false);
  const queueUris = useMemo(() => queue.map((q) => q.uri), [queue]);

  const load = useCallback(async () => {
    const savedFilters = await getShuffleFilters(db);
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
      await generateShuffledQueue(db, filters);
      await load();
    } finally {
      setShuffling(false);
    }
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

  const confirmRemove = (row: QueueRow) =>
    Alert.alert('Remove from queue?', `${row.name} — ${row.artists}`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await removeFromQueue(db, row.position);
          await load();
        },
      },
    ]);

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
        <NowPlaying queueUris={queueUris} />
        <Text style={screen.summary}>
          {queue.length} / {MAX_QUEUE_SIZE} songs · drawn from {shuffleTracks.toLocaleString()}
        </Text>
        <View style={screen.filters}>
          {FILTERS.map(({ key, label }) => {
            const on = filters[key];
            return (
              <Pressable
                key={key}
                onPress={() => toggleFilter(key)}
                disabled={shuffling}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={({ pressed }) => [screen.filter, on && screen.filterOn, pressed && { opacity: 0.7 }]}
              >
                <Ionicons
                  name={on ? 'checkbox' : 'square-outline'}
                  size={18}
                  color={on ? colors.accent : colors.textMuted}
                />
                <Text style={[screen.filterText, on && { color: colors.text }]}>{label}</Text>
              </Pressable>
            );
          })}
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

      <FlatList
        data={queue}
        keyExtractor={(item) => String(item.position)}
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
          <Pressable onLongPress={() => confirmRemove(item)} style={screen.row}>
            <Text style={screen.index}>{index + 1}</Text>
            <Artwork uri={item.image_url} size={44} />
            <View style={screen.rowText}>
              <Text style={screen.title} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={screen.subtitle} numberOfLines={1}>
                {item.artists} · {item.album_name}
              </Text>
            </View>
            <Text style={screen.duration}>{formatDuration(item.duration_ms)}</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { padding: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  summary: { color: colors.textMuted, fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  filterOn: { borderColor: colors.accent },
  filterText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  index: { color: colors.textMuted, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowText: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
