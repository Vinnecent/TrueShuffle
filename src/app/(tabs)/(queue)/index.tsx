import { useFocusEffect, useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Artwork, Button, EmptyState, styles as ui } from '@/components/ui';
import {
  generateShuffledQueue,
  getLibraryStats,
  getQueue,
  MAX_QUEUE_SIZE,
  removeFromQueue,
  type QueueRow,
} from '@/db/queries';
import { ensureLoggedInWithScopes, NotAuthenticatedError } from '@/spotify/auth';
import {
  describePlaybackError,
  openPlaylistInSpotify,
  playSpotifyPlaylist,
  sendToSpotifyPlaylist,
} from '@/spotify/playback';
import { colors, formatDuration } from '@/theme';

export default function QueueScreen() {
  const db = useSQLiteContext();
  const router = useRouter();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [libraryTracks, setLibraryTracks] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [shuffling, setShuffling] = useState(false);

  const load = useCallback(async () => {
    const [rows, stats] = await Promise.all([getQueue(db), getLibraryStats(db)]);
    setQueue(rows);
    setLibraryTracks(stats.tracks);
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const shuffle = async () => {
    setShuffling(true);
    try {
      await generateShuffledQueue(db);
      await load();
    } finally {
      setShuffling(false);
    }
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
      const playlistId = await sendToSpotifyPlaylist(queue.map((q) => q.uri));
      Alert.alert(
        'Playlist updated',
        `Your "TrueShuffle" playlist in Spotify now holds these ${queue.length} songs. ` +
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
        <Text style={screen.summary}>
          {queue.length} / {MAX_QUEUE_SIZE} songs · drawn from {libraryTracks.toLocaleString()}
        </Text>
        <View style={screen.actions}>
          <View style={{ flex: 1 }}>
            <Button title="Shuffle" variant="secondary" onPress={shuffle} loading={shuffling} disabled={sending} />
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
          <EmptyState title="No songs queued">
            <Text style={ui.muted}>Tap Shuffle to draw {MAX_QUEUE_SIZE} random songs from your library.</Text>
          </EmptyState>
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
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, gap: 12 },
  index: { color: colors.textMuted, width: 22, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowText: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  subtitle: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  duration: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
});
