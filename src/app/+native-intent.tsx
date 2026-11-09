/**
 * Expo Router treats every incoming deep link as a route to navigate to.
 * The Spotify login redirect (trueshuffle://callback?code=…) is not a screen: it is consumed by
 * expo-auth-session's own URL listener. Without this hook the router would also try to open it and
 * show "Unmatched Route".
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  try {
    if (isAuthCallback(path)) {
      // App already open (normal case): stay on the current screen (Settings).
      // App was cold-started by the redirect: there is no login waiting for it, so land on Settings.
      return initial ? '/settings' : null;
    }
    return path;
  } catch {
    return path;
  }
}

function isAuthCallback(path: string): boolean {
  // `path` may arrive as the full URL ("trueshuffle://callback?code=…") or already parsed ("/callback?…").
  const withoutScheme = path.replace(/^trueshuffle:\/*/i, '/');
  return /^\/*callback(?:[/?#]|$)/i.test(withoutScheme);
}
