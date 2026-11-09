import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  getBackgroundSyncStatus,
  isBackgroundSyncAvailable,
  isBackgroundSyncEnabled,
  setBackgroundSyncEnabled,
  type BackgroundSyncStatus,
} from '@/background/syncTask';
import { Button } from '@/components/ui';
import { clearLibrary, getLibraryStats, getMeta, type LibraryStats } from '@/db/queries';
import { RateLimitError } from '@/spotify/api';
import {
  ensureLoggedInWithScopes,
  getCredentials,
  isLoggedIn,
  login,
  logout,
  NotAuthenticatedError,
  REDIRECT_URI,
  saveCredentials,
} from '@/spotify/auth';
import {
  getRateLimitedUntil,
  SYNC_STARTED_KEY,
  SyncInProgressError,
  syncLibrary,
  type SyncProgress,
} from '@/spotify/sync';
import { colors } from '@/theme';

const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savedCreds, setSavedCreds] = useState({ clientId: '', clientSecret: '' });
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [syncInterrupted, setSyncInterrupted] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rateLimitedUntil, setRateLimitedUntil] = useState<Date | null>(null);
  const [background, setBackground] = useState<{
    available: boolean;
    enabled: boolean;
    status: BackgroundSyncStatus | null;
  } | null>(null);
  const [togglingBackground, setTogglingBackground] = useState(false);

  const apply = useCallback((state: Awaited<ReturnType<typeof loadState>>) => {
    setSavedCreds(state.creds);
    setConnected(state.loggedIn);
    setStats(state.stats);
    setSyncInterrupted(state.syncInterrupted);
    setRateLimitedUntil(state.rateLimitedUntil);
    setBackground(state.background);
  }, []);

  const refresh = useCallback(async () => apply(await loadState(db)), [apply, db]);

  // The background sync may have changed the library while this tab was not shown.
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const state = await loadState(db);
      if (cancelled) return;
      apply(state);
      setClientId(state.creds.clientId);
      setClientSecret(state.creds.clientSecret);
    })();
    return () => {
      cancelled = true;
    };
  }, [apply, db]);

  const dirty = clientId.trim() !== savedCreds.clientId || clientSecret.trim() !== savedCreds.clientSecret;
  const hasCreds = !!savedCreds.clientId && !!savedCreds.clientSecret;
  const syncing = progress !== null;

  const save = async () => {
    await saveCredentials({ clientId, clientSecret });
    await refresh();
  };

  const sync = async () => {
    setProgress({ phase: 'Starting', done: 0, total: 0 });
    try {
      await ensureLoggedInWithScopes();
      setConnected(true);
      let result;
      try {
        result = await syncLibrary(db, setProgress);
      } catch (e) {
        // Refresh token was revoked/expired: log in once more and retry.
        if (!(e instanceof NotAuthenticatedError)) throw e;
        await login();
        result = await syncLibrary(db, setProgress);
      }
      Alert.alert(
        'Sync complete',
        `${result.artists} artists · ${result.albums} releases · ${result.tracks.toLocaleString()} songs`,
      );
    } catch (e) {
      const resumeHint =
        '\n\nEverything synced so far is saved. Tap Sync again later and it continues where it stopped.';
      if (e instanceof SyncInProgressError) {
        Alert.alert('Already syncing', 'The background sync is running right now. Try again in a few minutes.');
      } else if (e instanceof RateLimitError) {
        Alert.alert('Spotify rate limit reached', e.message + resumeHint);
      } else {
        Alert.alert('Sync failed', (e as Error).message + resumeHint);
      }
    } finally {
      setProgress(null);
      await refresh();
    }
  };

  const disconnect = async () => {
    await logout();
    await refresh();
  };

  const toggleBackground = async () => {
    if (!background) return;
    setTogglingBackground(true);
    try {
      await setBackgroundSyncEnabled(!background.enabled);
    } catch (e) {
      Alert.alert('Could not change background sync', (e as Error).message);
    } finally {
      setTogglingBackground(false);
      await refresh();
    }
  };

  const wipeLibrary = async () => {
    setClearing(true);
    try {
      await clearLibrary(db);
      await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]);
    } catch (e) {
      Alert.alert('Could not clear the library', (e as Error).message);
    } finally {
      setClearing(false);
      await refresh();
    }
  };

  const confirmClearLibrary = () =>
    Alert.alert(
      'Clear library?',
      'This deletes all synced artists, releases and songs, the queue, the sync progress and the cached ' +
        'artwork from this phone. Your Spotify login, credentials and the playlist in Spotify are kept.\n\n' +
        'Syncing everything again can take several days because of Spotify’s limits.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear library', style: 'destructive', onPress: wipeLibrary },
      ],
    );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={screen.container} contentContainerStyle={screen.content} keyboardShouldPersistTaps="handled">
        <Text style={screen.sectionTitle}>Spotify app credentials</Text>
        <Text style={screen.help}>
          Create an app at{' '}
          <Text
            style={screen.link}
            accessibilityRole="link"
            onPress={() => Linking.openURL(SPOTIFY_DASHBOARD_URL)}
          >
            developer.spotify.com/dashboard
          </Text>{' '}
          (Web API), add the redirect URI below to it, and paste
          its Client ID and Client Secret here. They are kept in secure device storage.
        </Text>

        <CopyRedirectUri />

        <Text style={screen.label}>Client ID</Text>
        <TextInput
          value={clientId}
          onChangeText={setClientId}
          style={screen.input}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="e.g. 1a2b3c…"
          placeholderTextColor={colors.textMuted}
        />
        <Text style={screen.label}>Client Secret</Text>
        <TextInput
          value={clientSecret}
          onChangeText={setClientSecret}
          style={screen.input}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="••••••••"
          placeholderTextColor={colors.textMuted}
        />
        <Button title="Save credentials" variant="secondary" onPress={save} disabled={!dirty || syncing} />

        <View style={screen.divider} />

        <Text style={screen.sectionTitle}>Library</Text>
        <Text style={screen.help}>
          {connected ? 'Connected to Spotify.' : 'Not connected — syncing will ask you to log in to Spotify.'}
        </Text>
        {stats && (
          <Text style={screen.stats}>
            {stats.artists} artists · {stats.albums} releases · {stats.tracks.toLocaleString()} songs
            {'\n'}Artists scanned: {stats.scannedArtists} of {stats.artists}
            {'\n'}Last sync: {stats.lastSync ? new Date(stats.lastSync).toLocaleString() : 'never'}
            {syncInterrupted && !syncing ? '\nLast sync was interrupted. Syncing again continues it.' : ''}
            {rateLimitedUntil && !syncing
              ? `\nSpotify asks to wait until ${rateLimitedUntil.toLocaleString()} before syncing again.`
              : ''}
          </Text>
        )}

        <Button
          title={syncInterrupted ? 'Continue sync' : 'Sync library from Spotify'}
          onPress={sync}
          loading={syncing}
          disabled={!hasCreds || dirty || syncing || clearing}
        />
        {progress && <SyncStatus progress={progress} />}
        {!hasCreds && <Text style={screen.help}>Save your Client ID and Client Secret first.</Text>}
        {dirty && hasCreds && <Text style={screen.help}>Save your changed credentials first.</Text>}

        {background && (
          <Pressable
            onPress={toggleBackground}
            disabled={!background.available || togglingBackground}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: background.enabled, disabled: !background.available }}
            style={({ pressed }) => [screen.checkRow, pressed && screen.redirectPressed]}
          >
            <Ionicons
              name={background.enabled ? 'checkbox' : 'square-outline'}
              size={24}
              color={background.enabled ? colors.accent : colors.textMuted}
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={screen.checkTitle}>Background sync</Text>
              <Text style={screen.help}>
                {background.available
                  ? 'Continues the sync every few hours, even when the app is closed. Android decides ' +
                    'when it runs, usually while the phone is idle or charging.'
                  : 'Background tasks are not available on this device.'}
              </Text>
              {background.status && (
                <Text style={screen.help}>
                  Last run {new Date(background.status.at).toLocaleString()}: {background.status.message}
                </Text>
              )}
            </View>
          </Pressable>
        )}

        {connected && (
          <Button title="Disconnect Spotify account" variant="danger" onPress={disconnect} disabled={syncing} />
        )}
        {stats && (stats.artists > 0 || stats.lastSync !== null) && (
          <Button
            title="Clear library"
            variant="danger"
            onPress={confirmClearLibrary}
            loading={clearing}
            disabled={syncing || clearing}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function SyncStatus({ progress }: { progress: SyncProgress }) {
  const fraction = progress.total ? progress.done / progress.total : 0;
  return (
    <View style={screen.status}>
      <Text style={screen.statusText}>
        {progress.phase}
        {progress.total ? ` ${progress.done}/${progress.total}` : '…'}
        {progress.tracks !== undefined ? ` · ${progress.tracks.toLocaleString()} songs` : ''}
      </Text>
      {progress.total > 0 && (
        <View style={screen.progressTrack}>
          <View style={[screen.progressFill, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
      )}
      {progress.note && <Text style={screen.statusNote}>{progress.note}</Text>}
    </View>
  );
}

/** The whole box is one button: long-press copies the redirect URI to the clipboard. */
function CopyRedirectUri() {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async () => {
    await Clipboard.setStringAsync(REDIRECT_URI);
    setCopied(true);
    clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Pressable
      onLongPress={copy}
      accessibilityRole="button"
      accessibilityLabel={`Redirect URI ${REDIRECT_URI}`}
      accessibilityHint="Long-press to copy to the clipboard"
      style={({ pressed }) => [screen.redirect, pressed && screen.redirectPressed]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[screen.label, copied && { color: colors.accent }]}>
          {copied ? 'Copied to clipboard' : 'Redirect URI · long-press to copy'}
        </Text>
        <Text style={screen.mono}>{REDIRECT_URI}</Text>
      </View>
      <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={20} color={copied ? colors.accent : colors.textMuted} />
    </Pressable>
  );
}

async function loadState(db: SQLiteDatabase) {
  const [creds, loggedIn, stats, syncStartedAt, rateLimitedUntil, bgAvailable, bgEnabled, bgStatus] =
    await Promise.all([
      getCredentials(),
      isLoggedIn(),
      getLibraryStats(db),
      getMeta(db, SYNC_STARTED_KEY),
      getRateLimitedUntil(db),
      isBackgroundSyncAvailable().catch(() => false),
      isBackgroundSyncEnabled().catch(() => false),
      getBackgroundSyncStatus(db),
    ]);
  return {
    creds,
    loggedIn,
    stats,
    syncInterrupted: syncStartedAt !== null,
    rateLimitedUntil,
    background: { available: bgAvailable, enabled: bgEnabled, status: bgStatus },
  };
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  sectionTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  help: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  link: { color: colors.accent, textDecorationLine: 'underline' },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surfaceRaised,
    color: colors.text,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    marginTop: -6,
  },
  redirect: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
  },
  redirectPressed: { backgroundColor: colors.surfaceRaised },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 12,
  },
  checkTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  mono: { color: colors.accent, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 13 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 12 },
  stats: { color: colors.text, fontSize: 14, lineHeight: 20 },
  status: { gap: 8 },
  statusText: { color: colors.text, fontSize: 14, textAlign: 'center', fontVariant: ['tabular-nums'] },
  statusNote: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.accent },
});
