// Sets up the app's texts in the chosen language; first, so everything below can use them.
import '@/i18n';
// Defines the background sync task; must be loaded before anything else (see the file).
import '@/background/syncTask';

import { Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';

import { OverlayProvider } from '@/components/Overlay';
import { DATABASE_NAME, initDatabase } from '@/db/schema';
import { navigationTheme } from '@/theme';

// Closes the Spotify login browser popup when it redirects back into the app.
WebBrowser.maybeCompleteAuthSession();

export default function RootLayout() {
  return (
    <SQLiteProvider databaseName={DATABASE_NAME} onInit={initDatabase}>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style="light" />
        {/* Layer for the queue's long-press menu, above every screen and the tab bar. */}
        <OverlayProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </OverlayProvider>
      </ThemeProvider>
    </SQLiteProvider>
  );
}
