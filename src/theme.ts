import { DarkTheme, type Theme } from 'expo-router';

import { i18n, t } from '@/i18n';

export const colors = {
  background: '#121212',
  /** Cards, sheets, the tab bar and the playing song's row. */
  surface: '#232323',
  /** Inputs, secondary buttons, empty artwork and tracks on a background or surface. */
  surfaceRaised: '#333333',
  /** Pressed rows and the popped-out queue item: clearly lighter than background, surface and surfaceRaised. */
  highlight: '#454545',
  border: '#3A3A3A',
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

/** Local date and time in the app language's format, e.g. "09/11/2026 14:57" (24-hour clock). */
export function formatDateTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return t('date.full', {
    day: pad(d.getDate()),
    month: pad(d.getMonth() + 1),
    year: String(d.getFullYear()),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  });
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Short local date and time relative to now: "today 14:57", "yesterday 08:12", "tomorrow 09:00",
 * "3 days ago", and the full date (see formatDateTime) for anything further away.
 */
export function formatRelativeDateTime(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return t('date.today', { time });
  if (days === 1) return t('date.yesterday', { time });
  if (days === -1) return t('date.tomorrow', { time });
  if (days > 1 && days < 7) return t('date.daysAgo', { count: days });
  return formatDateTime(d);
}

/** A number with the app language's digit grouping, e.g. 12,673 in English and 12.673 in German. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(i18n.language).format(value);
}

/** Things counted in the UI; each has singular and plural forms in the translations (`count.*`). */
export type CountUnit = 'artist' | 'release' | 'song' | 'excludedArtist';

/** A count with the right word form in the app language, e.g. "1 song", "2 songs", "1,204 releases". */
export function countLabel(count: number, unit: CountUnit): string {
  return t(`count.${unit}`, { count });
}
