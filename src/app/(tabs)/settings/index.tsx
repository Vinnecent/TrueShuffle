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
import {
  importLibrary,
  InvalidBackupError,
  pickBackup,
  saveLibraryToFolder,
  shareLibrary,
  summarizeBackup,
} from '@/backup/backup';
import { Button } from '@/components/ui';
import { clearLibrary, getLibraryStats, type LibraryStats } from '@/db/queries';
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
  SyncInProgressError,
  syncLibrary,
  type SyncProgress,
} from '@/spotify/sync';
import { colors, countLabel, formatRelativeDateTime } from '@/theme';

const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [savedCreds, setSavedCreds] = useState({ clientId: '', clientSecret: '' });
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [clearing, setClearing] = useState(false);
  const [backingUp, setBackingUp] = useState<'export' | 'import' | null>(null);
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

  // Re-enable "Sync" as soon as Spotify's wait is over, without having to leave the screen.
  useEffect(() => {
    if (!rateLimitedUntil) return;
    const timer = setTimeout(() => setRateLimitedUntil(null), Math.max(0, rateLimitedUntil.getTime() - Date.now()));
    return () => clearTimeout(timer);
  }, [rateLimitedUntil]);

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
  const hasLibrary = !!stats && (stats.artists > 0 || stats.lastSync !== null);

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
        result.scanned === 0 ? 'Library is up to date' : 'Sync complete',
        result.scanned === 0
          ? 'Every included artist was updated within the last hour.'
          : `Updated ${countLabel(result.scanned, 'artist')}.\n\n` +
              `${countLabel(result.artists, 'artist')} · ${countLabel(result.albums, 'release')} · ${countLabel(result.tracks, 'song')}`,
      );
    } catch (e) {
      const resumeHint =
        '\n\nEverything synced so far is saved. Tap Sync again later and it continues with the artists it did not reach.';
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

  const runExport = async (how: 'save' | 'share') => {
    setBackingUp('export');
    try {
      if (how === 'share') {
        await shareLibrary(db);
      } else {
        const name = await saveLibraryToFolder(db);
        if (name) Alert.alert('Backup saved', `Saved as “${name}” in the folder you chose.`);
      }
    } catch (e) {
      Alert.alert('Could not export the library', (e as Error).message);
    } finally {
      setBackingUp(null);
    }
  };

  const exportBackup = () =>
    Alert.alert('Export library', 'Save the backup file on this phone, or share it to another app or a cloud drive.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Share…', onPress: () => runExport('share') },
      { text: 'Save to this phone', onPress: () => runExport('save') },
    ]);

  const importBackup = async () => {
    setBackingUp('import');
    try {
      const backup = await pickBackup();
      if (!backup) return;
      const summary = summarizeBackup(backup);
      const replace = async () => {
        setBackingUp('import');
        try {
          await importLibrary(db, backup);
          Alert.alert('Library imported', `${countLabel(summary.artists, 'artist')} · ${countLabel(summary.tracks, 'song')}`);
        } catch (e) {
          Alert.alert('Could not import the backup', `${(e as Error).message}\n\nYour library was not changed.`);
        } finally {
          setBackingUp(null);
          await refresh();
        }
      };
      Alert.alert(
        'Replace your library?',
        `Backup from ${formatRelativeDateTime(summary.exportedAt)}: ${countLabel(summary.artists, 'artist')}, ` +
          `${countLabel(summary.albums, 'release')}, ${countLabel(summary.tracks, 'song')}.\n\n` +
          'Your current library, queue and shuffle settings on this phone are replaced. ' +
          'Your Spotify credentials and login stay as they are.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Replace library', style: 'destructive', onPress: replace },
        ],
      );
    } catch (e) {
      Alert.alert(
        e instanceof InvalidBackupError ? 'Not a TrueShuffle backup' : 'Could not read the file',
        (e as Error).message,
      );
    } finally {
      setBackingUp(null);
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
          {connected ? 'Connected' : 'Not connected, syncing will ask you to log in'}
          {stats ? ` · Last sync ${stats.lastSync ? formatRelativeDateTime(stats.lastSync) : 'never'}` : ''}
        </Text>

        {stats && (
          <>
            <View style={screen.tiles}>
              <StatTile value={stats.artists} label="artists" />
              <StatTile value={stats.albums} label="releases" />
              <StatTile value={stats.tracks} label="songs" />
            </View>

            <FreshnessBar stats={stats} />
          </>
        )}

        <Button
          title={
            rateLimitedUntil && !syncing
              ? `Sync available ${formatRelativeDateTime(rateLimitedUntil)}`
              : 'Sync library from Spotify'
          }
          onPress={sync}
          loading={syncing}
          disabled={!hasCreds || dirty || syncing || clearing || rateLimitedUntil !== null}
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
                  ? 'Updates your library about twice a day'
                  : 'Background tasks are not available on this device.'}
              </Text>
              {background.status && (
                <Text style={screen.help}>
                  Last run {formatRelativeDateTime(background.status.at)} · {background.status.message}
                </Text>
              )}
            </View>
            {background.available && (
              <Pressable
                onPress={explainBackgroundSync}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="About background sync"
              >
                <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
              </Pressable>
            )}
          </Pressable>
        )}

        <View style={screen.divider} />
        <Text style={screen.sectionTitle}>Backup</Text>
        <Text style={screen.help}>
          Move your synced library to another phone: export it to a file, then import that file there. Your Spotify
          credentials and login are not included.
        </Text>
        <View style={screen.buttonRow}>
          <View style={{ flex: 1 }}>
            <Button
              title="Export"
              variant="secondary"
              onPress={exportBackup}
              loading={backingUp === 'export'}
              disabled={!hasLibrary || syncing || clearing || backingUp !== null}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Import"
              variant="secondary"
              onPress={importBackup}
              loading={backingUp === 'import'}
              disabled={syncing || clearing || backingUp !== null}
            />
          </View>
        </View>

        {(connected || hasLibrary) && (
          <>
            <View style={screen.divider} />
            <Text style={screen.sectionTitle}>Reset</Text>
            <Text style={screen.help}>
              Log out of Spotify, or delete everything synced to this phone. Your credentials and filters are kept.
            </Text>
            {connected && (
              <Button title="Disconnect Spotify account" variant="danger" onPress={disconnect} disabled={syncing} />
            )}
            {hasLibrary && (
              <Button
                title="Clear library"
                variant="danger"
                onPress={confirmClearLibrary}
                loading={clearing}
                disabled={syncing || clearing}
              />
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const explainBackgroundSync = () =>
  Alert.alert(
    'Background sync',
    'While the app is closed, Android runs the sync about twice a day, usually while the phone is idle or ' +
      'charging; it decides the exact time. Each run updates the artists not checked for a week, oldest first ' +
      '(artists never scanned go first), for a few minutes. Runs with nothing to do, or during a wait Spotify ' +
      'asked for, end without contacting Spotify.',
  );

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <View style={screen.tile}>
      <Text style={screen.tileValue} numberOfLines={1} adjustsFontSizeToFit>
        {value.toLocaleString()}
      </Text>
      <Text style={screen.tileLabel}>{label}</Text>
    </View>
  );
}

/** "Up to date" bar: included artists scanned within the last week, plus what is still missing. */
function FreshnessBar({ stats }: { stats: LibraryStats }) {
  const included = stats.artists - stats.excludedArtists;
  const fraction = included > 0 ? stats.freshArtists / included : 0;
  const details = [
    stats.unscannedArtists > 0 ? `${stats.unscannedArtists} not scanned yet` : null,
    stats.excludedArtists > 0 ? `${stats.excludedArtists} excluded` : null,
  ].filter(Boolean);
  return (
    <View style={{ gap: 6 }}>
      <View style={screen.freshRow}>
        <Text style={screen.freshLabel}>Up to date</Text>
        <View style={[screen.progressTrack, { flex: 1 }]}>
          <View style={[screen.progressFill, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
        <Text style={screen.freshCount}>
          {stats.freshArtists.toLocaleString()} / {included.toLocaleString()}
        </Text>
      </View>
      {details.length > 0 && <Text style={screen.help}>{details.join(' · ')}</Text>}
    </View>
  );
}

function SyncStatus({ progress }: { progress: SyncProgress }) {
  const fraction = progress.total ? progress.done / progress.total : 0;
  return (
    <View style={screen.status}>
      <Text style={screen.statusText}>
        {progress.phase}
        {progress.total ? ` ${progress.done}/${progress.total}` : '…'}
        {progress.tracks !== undefined ? ` · ${countLabel(progress.tracks, 'song')}` : ''}
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
  const [creds, loggedIn, stats, rateLimitedUntil, bgAvailable, bgEnabled, bgStatus] =
    await Promise.all([
      getCredentials(),
      isLoggedIn(),
      getLibraryStats(db),
      getRateLimitedUntil(db),
      isBackgroundSyncAvailable().catch(() => false),
      isBackgroundSyncEnabled().catch(() => false),
      getBackgroundSyncStatus(db),
    ]);
  return {
    creds,
    loggedIn,
    stats,
    rateLimitedUntil,
    background: { available: bgAvailable, enabled: bgEnabled, status: bgStatus },
  };
}

const screen = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingTop: 8, gap: 12, paddingBottom: 48 },
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
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginVertical: 4 },
  tiles: { flexDirection: 'row', gap: 8 },
  buttonRow: { flexDirection: 'row', gap: 12 },
  tile: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 8, backgroundColor: colors.surface },
  tileValue: { color: colors.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tileLabel: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  freshRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  freshLabel: { color: colors.text, fontSize: 14, fontWeight: '600' },
  freshCount: { color: colors.textMuted, fontSize: 13, fontVariant: ['tabular-nums'] },
  status: { gap: 8 },
  statusText: { color: colors.text, fontSize: 14, textAlign: 'center', fontVariant: ['tabular-nums'] },
  statusNote: { color: colors.textMuted, fontSize: 13, textAlign: 'center' },
  progressTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  progressFill: { height: 4, backgroundColor: colors.accent },
});
