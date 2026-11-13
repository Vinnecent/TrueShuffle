import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { Artwork } from '@/components/ui';
import { addFollowedArtist, getKnownArtistIds } from '@/db/queries';
import { followArtist, pickImage, searchArtists } from '@/spotify/api';
import { ensureLoggedInWithScopes, NotAuthenticatedError } from '@/spotify/auth';
import { colors } from '@/theme';

/** Artists shown per Spotify search. */
const RESULT_COUNT = 5;

type Result = { id: string; name: string; image_url: string | null; following: boolean };

type Props = {
  /** What the user typed in the Artists search. */
  query: string;
  /** An artist was followed and added to the library: reload the list. */
  onFollowed: () => void;
};

/**
 * "Search on Spotify" under the Artists tab's search: finds up to 5 artists on Spotify (one request, only when
 * the button is pressed) and follows one with a tap, adding it to the library right away.
 */
export function SpotifyArtistSearch({ query, onFollowed }: Props) {
  const { t } = useTranslation();
  const db = useSQLiteContext();
  const router = useRouter();
  const [results, setResults] = useState<{ query: string; artists: Result[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [followingId, setFollowingId] = useState<string | null>(null);

  const trimmed = query.trim();
  // Results belong to the text they were searched for; typing something else shows the button again.
  const shown = results && results.query === trimmed ? results.artists : null;

  const showError = (e: unknown, title: string) => {
    if (e instanceof NotAuthenticatedError) {
      Alert.alert(t('queue.notConnectedTitle'), t('queue.notConnectedText'), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('queue.openSettings'), onPress: () => router.navigate('/settings') },
      ]);
    } else {
      Alert.alert(title, (e as Error).message);
    }
  };

  const search = async () => {
    setSearching(true);
    try {
      // Asks for a (re-)login if the stored one predates the follow permission.
      await ensureLoggedInWithScopes();
      const found = await searchArtists(trimmed, RESULT_COUNT);
      const known = await getKnownArtistIds(
        db,
        found.map((a) => a.id),
      );
      setResults({
        query: trimmed,
        artists: found.map((a) => ({
          id: a.id,
          name: a.name,
          image_url: pickImage(a.images),
          following: known.has(a.id),
        })),
      });
    } catch (e) {
      showError(e, t('artists.spotifySearchFailed'));
    } finally {
      setSearching(false);
    }
  };

  const follow = async (artist: Result) => {
    setFollowingId(artist.id);
    try {
      await ensureLoggedInWithScopes();
      await followArtist(artist.id);
      await addFollowedArtist(db, artist);
      setResults((r) =>
        r ? { ...r, artists: r.artists.map((a) => (a.id === artist.id ? { ...a, following: true } : a)) } : r,
      );
      onFollowed();
    } catch (e) {
      showError(e, t('artists.followFailed', { name: artist.name }));
    } finally {
      setFollowingId(null);
    }
  };

  if (!trimmed) return null;

  return (
    <View style={sheet.container}>
      {shown === null ? (
        <Pressable
          onPress={search}
          disabled={searching}
          accessibilityRole="button"
          style={({ pressed }) => [sheet.searchButton, pressed && { backgroundColor: colors.highlight }]}
        >
          {searching ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Ionicons name="search" size={18} color={colors.accent} />
          )}
          <Text style={sheet.searchText} numberOfLines={1}>
            {t('artists.searchOnSpotify', { query: trimmed })}
          </Text>
        </Pressable>
      ) : (
        <>
          <Text style={sheet.heading}>{t('artists.onSpotify')}</Text>
          {shown.length === 0 && <Text style={sheet.none}>{t('artists.noSpotifyResults')}</Text>}
          {shown.map((artist) => (
            <View key={artist.id} style={sheet.row}>
              <Artwork uri={artist.image_url} size={44} round />
              <Text style={sheet.name} numberOfLines={1}>
                {artist.name}
              </Text>
              {artist.following ? (
                <View style={sheet.followingBadge}>
                  <Ionicons name="checkmark" size={16} color={colors.textMuted} />
                  <Text style={sheet.followingText}>{t('artists.following')}</Text>
                </View>
              ) : (
                <Pressable
                  onPress={() => follow(artist)}
                  disabled={followingId !== null}
                  accessibilityRole="button"
                  accessibilityLabel={t('artists.followLabel', { name: artist.name })}
                  style={({ pressed }) => [sheet.followButton, pressed && { opacity: 0.8 }]}
                >
                  {followingId === artist.id ? (
                    <ActivityIndicator size="small" color={colors.accentText} />
                  ) : (
                    <Text style={sheet.followText}>{t('artists.follow')}</Text>
                  )}
                </Pressable>
              )}
            </View>
          ))}
        </>
      )}
    </View>
  );
}

const sheet = StyleSheet.create({
  container: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 24, gap: 8 },
  searchButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchText: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  heading: { color: colors.textMuted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', marginTop: 4 },
  none: { color: colors.textMuted, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 6 },
  name: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600' },
  followButton: {
    minWidth: 88,
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.accent,
  },
  followText: { color: colors.accentText, fontSize: 14, fontWeight: '700' },
  followingBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  followingText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
});
