import { DarkTheme, type Theme } from 'expo-router';

export const colors = {
  background: '#121212',
  surface: '#1E1E1E',
  surfaceRaised: '#2A2A2A',
  border: '#2E2E2E',
  text: '#FFFFFF',
  textMuted: '#A7A7A7',
  accent: '#1ED760',
  accentText: '#000000',
  danger: '#F15E6C',
} as const;

export const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
  },
};

/**
 * Shared by every tab's Stack, so all tabs render the same native header
 * (same height, colours and title position).
 */
export const stackScreenOptions = {
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.text,
  contentStyle: { backgroundColor: colors.background },
};

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Local date and time as "dd/mm/yyyy HH:MM" (24-hour clock), e.g. "09/11/2026 14:57".
 * Built by hand so the format is the same whatever the phone's locale settings are.
 */
export function formatDateTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
