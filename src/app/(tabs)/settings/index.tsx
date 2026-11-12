import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext, type SQLiteDatabase } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
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
  describeBackgroundSyncStatus,
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
import { getLanguageSetting, i18n, LANGUAGES, setLanguageSetting, systemLanguage, type LanguageSetting } from '@/i18n';
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
import { colors, countLabel, formatNumber, formatRelativeDateTime } from '@/theme';

const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

export default function SettingsScreen() {
  const { t } = useTranslation();
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
  /** False until the stored state is read, so the screen does not first render without the other sections. */
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((state: Awaited<ReturnType<typeof loadState>>) => {
    setSavedCreds(state.creds);
    setConnected(state.loggedIn);
    setStats(state.stats);
    setRateLimitedUntil(state.rateLimitedUntil);
    setBackground(state.background);
    setLoaded(true);
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
    setProgress({ phase: 'starting', done: 0, total: 0 });
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
        result.scanned === 0 ? t('settings.upToDateTitle') : t('settings.syncCompleteTitle'),
        result.scanned === 0
          ? t('settings.upToDateText')
          : `${t('settings.syncUpdated', { count: result.scanned })}\n\n` +
              [
                countLabel(result.artists, 'artist'),
                countLabel(result.albums, 'release'),
                countLabel(result.tracks, 'song'),
              ].join(' · '),
      );
    } catch (e) {
      const resumeHint = `\n\n${t('settings.resumeHint')}`;
      if (e instanceof SyncInProgressError) {
        Alert.alert(t('settings.alreadySyncingTitle'), t('settings.alreadySyncingText'));
      } else if (e instanceof RateLimitError) {
        Alert.alert(t('settings.rateLimitTitle'), e.message + resumeHint);
      } else {
        Alert.alert(t('settings.syncFailedTitle'), (e as Error).message + resumeHint);
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
      Alert.alert(t('settings.backgroundToggleFailed'), (e as Error).message);
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
      Alert.alert(t('settings.clearFailed'), (e as Error).message);
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
        if (name) Alert.alert(t('settings.backupSavedTitle'), t('settings.backupSavedText', { name }));
      }
    } catch (e) {
      Alert.alert(t('settings.exportFailed'), (e as Error).message);
    } finally {
      setBackingUp(null);
    }
  };

  const exportBackup = () =>
    Alert.alert(t('settings.exportTitle'), t('settings.exportText'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.exportShare'), onPress: () => runExport('share') },
      { text: t('settings.exportSave'), onPress: () => runExport('save') },
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
          Alert.alert(
            t('settings.importedTitle'),
            `${countLabel(summary.artists, 'artist')} · ${countLabel(summary.tracks, 'song')}`,
          );
        } catch (e) {
          Alert.alert(
            t('settings.importFailedTitle'),
            `${(e as Error).message}\n\n${t('settings.importFailedUnchanged')}`,
          );
        } finally {
          setBackingUp(null);
          await refresh();
        }
      };
      Alert.alert(
        t('settings.replaceTitle'),
        t('settings.replaceText', {
          when: formatRelativeDateTime(summary.exportedAt),
          contents: [
            countLabel(summary.artists, 'artist'),
            countLabel(summary.albums, 'release'),
            countLabel(summary.tracks, 'song'),
          ].join(', '),
        }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('settings.replaceConfirm'), style: 'destructive', onPress: replace },
        ],
      );
    } catch (e) {
      Alert.alert(
        e instanceof InvalidBackupError ? t('settings.notBackupTitle') : t('settings.readFailedTitle'),
        (e as Error).message,
      );
    } finally {
      setBackingUp(null);
    }
  };

  const confirmClearLibrary = () =>
    Alert.alert(t('settings.clearTitle'), t('settings.clearText'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('settings.clearLibrary'), style: 'destructive', onPress: wipeLibrary },
    ]);

  if (!loaded) return <View style={screen.container} />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={screen.container} contentContainerStyle={screen.content} keyboardShouldPersistTaps="handled">
        <Text style={screen.sectionTitle}>{t('settings.credentialsTitle')}</Text>
        <Text style={screen.help}>
          <Trans
            i18nKey="settings.credentialsHelp"
            components={{
              dashboard: (
                <Text
                  style={screen.link}
                  accessibilityRole="link"
                  onPress={() => Linking.openURL(SPOTIFY_DASHBOARD_URL)}
                />
              ),
            }}
          />
        </Text>

        <CopyRedirectUri />

        <Text style={screen.label}>{t('settings.clientId')}</Text>
        <TextInput
          value={clientId}
          onChangeText={setClientId}
          style={screen.input}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('settings.clientIdPlaceholder')}
          placeholderTextColor={colors.textMuted}
        />
        <Text style={screen.label}>{t('settings.clientSecret')}</Text>
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
        <Button title={t('settings.saveCredentials')} variant="secondary" onPress={save} disabled={!dirty || syncing} />

        {/* Everything else needs the Spotify app, so it only appears once its credentials are saved. */}
        {hasCreds && (
          <>
            <View style={screen.divider} />

            <Text style={screen.sectionTitle}>{t('settings.libraryTitle')}</Text>
            <Text style={screen.help}>
              {connected ? t('settings.connected') : t('settings.notConnected')}
              {stats
                ? ` · ${t('settings.lastSync', {
                    when: stats.lastSync ? formatRelativeDateTime(stats.lastSync) : t('settings.never'),
                  })}`
                : ''}
            </Text>

            {stats && (
              <>
                <View style={screen.tiles}>
                  <StatTile value={stats.artists} label={t('settings.tileArtists')} />
                  <StatTile value={stats.albums} label={t('settings.tileReleases')} />
                  <StatTile value={stats.tracks} label={t('settings.tileSongs')} />
                </View>

                <FreshnessBar stats={stats} />
              </>
            )}

            <Button
              title={
                rateLimitedUntil && !syncing
                  ? t('settings.syncAvailable', { when: formatRelativeDateTime(rateLimitedUntil) })
                  : t('settings.sync')
              }
              onPress={sync}
              loading={syncing}
              disabled={dirty || syncing || clearing || rateLimitedUntil !== null}
            />
            {progress && <SyncStatus progress={progress} />}
            {dirty && <Text style={screen.help}>{t('settings.saveChangedFirst')}</Text>}

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
                  <Text style={screen.checkTitle}>{t('settings.backgroundTitle')}</Text>
                  <Text style={screen.help}>
                    {background.available ? t('settings.backgroundHelp') : t('settings.backgroundUnavailable')}
                  </Text>
                  {background.status && (
                    <Text style={screen.help}>
                      {t('settings.backgroundLastRun', {
                        when: formatRelativeDateTime(background.status.at),
                        status: describeBackgroundSyncStatus(background.status),
                      })}
                    </Text>
                  )}
                </View>
                {background.available && (
                  <Pressable
                    onPress={explainBackgroundSync}
                    hitSlop={12}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.backgroundAbout')}
                  >
                    <Ionicons name="information-circle-outline" size={22} color={colors.textMuted} />
                  </Pressable>
                )}
              </Pressable>
            )}

            <View style={screen.divider} />
            <Text style={screen.sectionTitle}>{t('settings.backupTitle')}</Text>
            <Text style={screen.help}>{t('settings.backupHelp')}</Text>
            <View style={screen.buttonRow}>
              <View style={{ flex: 1 }}>
                <Button
                  title={t('settings.export')}
                  variant="secondary"
                  onPress={exportBackup}
                  loading={backingUp === 'export'}
                  disabled={!hasLibrary || syncing || clearing || backingUp !== null}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  title={t('settings.import')}
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
                <Text style={screen.sectionTitle}>{t('settings.resetTitle')}</Text>
                <Text style={screen.help}>{t('settings.resetHelp')}</Text>
                {connected && (
                  <Button title={t('settings.disconnect')} variant="danger" onPress={disconnect} disabled={syncing} />
                )}
                {hasLibrary && (
                  <Button
                    title={t('settings.clearLibrary')}
                    variant="danger"
                    onPress={confirmClearLibrary}
                    loading={clearing}
                    disabled={syncing || clearing}
                  />
                )}
              </>
            )}
          </>
        )}

        <View style={screen.divider} />
        <LanguagePicker />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const explainBackgroundSync = () =>
  Alert.alert(i18n.t('settings.backgroundTitle'), i18n.t('settings.backgroundExplain'));

/** Language of the app's texts: the phone's language (default) or a fixed one. */
function LanguagePicker() {
  const { t } = useTranslation();
  const [setting, setSetting] = useState<LanguageSetting>(getLanguageSetting);
  const systemName = LANGUAGES.find((l) => l.code === systemLanguage())?.name ?? 'English';
  const options: { key: LanguageSetting; label: string }[] = [
    { key: 'system', label: t('settings.languageSystem') },
    ...LANGUAGES.map((l) => ({ key: l.code, label: l.name })),
  ];

  const choose = async (next: LanguageSetting) => {
    setSetting(next);
    await setLanguageSetting(next);
  };

  return (
    <>
      <Text style={screen.sectionTitle}>{t('settings.languageTitle')}</Text>
      <View style={screen.segments} accessibilityRole="radiogroup">
        {options.map(({ key, label }) => {
          const selected = setting === key;
          return (
            <Pressable
              key={key}
              onPress={() => choose(key)}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              style={({ pressed }) => [
                screen.segment,
                selected && screen.segmentSelected,
                pressed && !selected && { opacity: 0.7 },
              ]}
            >
              <Text style={[screen.segmentText, selected && screen.segmentTextSelected]} numberOfLines={1}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {setting === 'system' && (
        <Text style={screen.help}>{t('settings.languageSystemHelp', { language: systemName })}</Text>
      )}
    </>
  );
}

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <View style={screen.tile}>
      <Text style={screen.tileValue} numberOfLines={1} adjustsFontSizeToFit>
        {formatNumber(value)}
      </Text>
      <Text style={screen.tileLabel}>{label}</Text>
    </View>
  );
}

/** "Up to date" bar: included artists scanned within the last week, plus what is still missing. */
function FreshnessBar({ stats }: { stats: LibraryStats }) {
  const { t } = useTranslation();
  const included = stats.artists - stats.excludedArtists;
  const fraction = included > 0 ? stats.freshArtists / included : 0;
  const details = [
    stats.unscannedArtists > 0 ? t('settings.notScannedYet', { count: stats.unscannedArtists }) : null,
    stats.excludedArtists > 0 ? t('settings.excluded', { count: stats.excludedArtists }) : null,
  ].filter(Boolean);
  return (
    <View style={{ gap: 6 }}>
      <View style={screen.freshRow}>
        <Text style={screen.freshLabel}>{t('settings.upToDate')}</Text>
        <View style={[screen.progressTrack, { flex: 1 }]}>
          <View style={[screen.progressFill, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
        <Text style={screen.freshCount}>
          {formatNumber(stats.freshArtists)} / {formatNumber(included)}
        </Text>
      </View>
      {details.length > 0 && <Text style={screen.help}>{details.join(' · ')}</Text>}
    </View>
  );
}

function SyncStatus({ progress }: { progress: SyncProgress }) {
  const { t } = useTranslation();
  const fraction = progress.total ? progress.done / progress.total : 0;
  return (
    <View style={screen.status}>
      <Text style={screen.statusText}>
        {t(`settings.phase.${progress.phase}`)}
        {progress.total ? ` ${progress.done}/${progress.total}` : '…'}
        {progress.tracks !== undefined ? ` · ${countLabel(progress.tracks, 'song')}` : ''}
      </Text>
      {progress.total > 0 && (
        <View style={screen.progressTrack}>
          <View style={[screen.progressFill, { width: `${Math.round(fraction * 100)}%` }]} />
        </View>
      )}
      {progress.rateLimitWaitSeconds !== undefined && (
        <Text style={screen.statusNote}>
          {t('settings.rateLimitWait', { seconds: Math.ceil(progress.rateLimitWaitSeconds) })}
        </Text>
      )}
    </View>
  );
}

/** The whole box is one button: long-press copies the redirect URI to the clipboard. */
function CopyRedirectUri() {
  const { t } = useTranslation();
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
      accessibilityLabel={t('settings.redirectUriLabel', { uri: REDIRECT_URI })}
      accessibilityHint={t('settings.redirectUriHint')}
      style={({ pressed }) => [screen.redirect, pressed && screen.redirectPressed]}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={[screen.label, copied && { color: colors.accent }]}>
          {copied ? t('settings.copied') : t('settings.redirectUri')}
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
  redirectPressed: { backgroundColor: colors.highlight },
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
  segments: { flexDirection: 'row', padding: 3, borderRadius: 10, backgroundColor: colors.surfaceRaised },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 8, paddingHorizontal: 4, borderRadius: 8 },
  segmentSelected: { backgroundColor: colors.accent },
  segmentText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  segmentTextSelected: { color: colors.accentText },
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
