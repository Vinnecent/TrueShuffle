import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';

import { t } from '@/i18n';

const KEYS = {
  clientId: 'spotify_client_id',
  clientSecret: 'spotify_client_secret',
  tokens: 'spotify_tokens',
} as const;

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: 'https://accounts.spotify.com/authorize',
  tokenEndpoint: 'https://accounts.spotify.com/api/token',
};

/**
 * user-follow-read: list followed artists.
 * user-follow-modify / user-library-modify: follow an artist found with the Spotify search on the Artists tab
 *   (saved through the library endpoint, whose docs list both scopes without saying which one artists need).
 * playlist-modify-private / playlist-read-private: create and fill the private "TrueShuffle" playlist,
 *   and check it still exists in the user's library.
 * *-playback-state: optionally start playing that playlist (Premium only).
 */
export const SCOPES = [
  'user-follow-read',
  'user-follow-modify',
  'user-library-modify',
  'playlist-modify-private',
  'playlist-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
];

/** Must be added verbatim under "Redirect URIs" in the Spotify developer dashboard. */
export const REDIRECT_URI = AuthSession.makeRedirectUri({ scheme: 'trueshuffle', path: 'callback' });

export class NotAuthenticatedError extends Error {
  constructor(message = t('errors.notConnected')) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

// ---------------------------------------------------------------- credentials

export type Credentials = { clientId: string; clientSecret: string };

export async function getCredentials(): Promise<Credentials> {
  const [clientId, clientSecret] = await Promise.all([
    SecureStore.getItemAsync(KEYS.clientId),
    SecureStore.getItemAsync(KEYS.clientSecret),
  ]);
  return { clientId: clientId ?? '', clientSecret: clientSecret ?? '' };
}

export async function saveCredentials({ clientId, clientSecret }: Credentials): Promise<void> {
  const prev = await getCredentials();
  await Promise.all([
    SecureStore.setItemAsync(KEYS.clientId, clientId.trim()),
    SecureStore.setItemAsync(KEYS.clientSecret, clientSecret.trim()),
  ]);
  // Tokens belong to the old app registration; force a new login if it changed.
  if (prev.clientId !== clientId.trim() || prev.clientSecret !== clientSecret.trim()) {
    await logout();
  }
}

// ---------------------------------------------------------------- tokens

type StoredTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  /** Space-separated scopes the user granted (missing for logins made by older app versions). */
  scope?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

async function readTokens(): Promise<StoredTokens | null> {
  const raw = await SecureStore.getItemAsync(KEYS.tokens);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return null;
  }
}

async function writeTokens(res: TokenResponse, previous?: StoredTokens): Promise<StoredTokens> {
  const tokens: StoredTokens = {
    accessToken: res.access_token,
    // Spotify does not always return a new refresh token / scope list when refreshing.
    refreshToken: res.refresh_token ?? previous?.refreshToken ?? '',
    expiresAt: Date.now() + res.expires_in * 1000,
    scope: res.scope ?? previous?.scope,
  };
  await SecureStore.setItemAsync(KEYS.tokens, JSON.stringify(tokens));
  return tokens;
}

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function tokenRequest(params: Record<string, string>, creds: Credentials): Promise<TokenResponse> {
  const res = await fetch(discovery.tokenEndpoint!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
    },
    body: formEncode(params),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !body.access_token) {
    throw new Error(
      t('errors.tokenRequestFailed', { message: String(body.error_description ?? body.error ?? res.status) }),
    );
  }
  return body;
}

export async function isLoggedIn(): Promise<boolean> {
  return (await readTokens()) !== null;
}

/** True when the stored login granted every scope the app currently needs. */
export async function hasRequiredScopes(): Promise<boolean> {
  const granted = new Set((await readTokens())?.scope?.split(' ') ?? []);
  return SCOPES.every((s) => granted.has(s));
}

/** Logs in again if there is no login yet, or it was made before the app needed more permissions. */
export async function ensureLoggedInWithScopes(): Promise<void> {
  if (!(await hasRequiredScopes())) await login();
}

/** Opens the Spotify login page (Authorization Code flow) and stores the resulting tokens. */
export async function login(): Promise<void> {
  const creds = await getCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(t('errors.credentialsMissing'));
  }

  const request = new AuthSession.AuthRequest({
    clientId: creds.clientId,
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    responseType: AuthSession.ResponseType.Code,
    usePKCE: false, // we authenticate the code exchange with the client secret instead
  });
  const result = await request.promptAsync(discovery);

  if (result.type === 'error') {
    throw new Error(result.error?.message ?? result.params.error ?? t('errors.loginFailed'));
  }
  if (result.type !== 'success') throw new Error(t('errors.loginCancelled'));

  const res = await tokenRequest(
    { grant_type: 'authorization_code', code: result.params.code, redirect_uri: REDIRECT_URI },
    creds,
  );
  await writeTokens(res);
}

export async function logout(): Promise<void> {
  await SecureStore.deleteItemAsync(KEYS.tokens);
  // The playlist belongs to the account that was logged in; a different account needs its own.
  await SecureStore.deleteItemAsync(PLAYLIST_ID_KEY);
}

/** Secure-store key of the TrueShuffle playlist's Spotify ID (see playback.ts). */
export const PLAYLIST_ID_KEY = 'spotify_playlist_id';

let refreshInFlight: Promise<StoredTokens> | null = null;

async function refresh(tokens: StoredTokens): Promise<StoredTokens> {
  // Several parallel requests may notice an expired token at once; refresh only once.
  refreshInFlight ??= (async () => {
    try {
      const creds = await getCredentials();
      const res = await tokenRequest(
        { grant_type: 'refresh_token', refresh_token: tokens.refreshToken },
        creds,
      );
      return await writeTokens(res, tokens);
    } catch (e) {
      await logout();
      throw new NotAuthenticatedError(t('errors.sessionExpired', { message: (e as Error).message }));
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Returns a valid access token, refreshing it if it expires within a minute. */
export async function getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
  const tokens = await readTokens();
  if (!tokens) throw new NotAuthenticatedError();
  if (options.forceRefresh || tokens.expiresAt - Date.now() < 60_000) {
    return (await refresh(tokens)).accessToken;
  }
  return tokens.accessToken;
}
