import { getLocales } from 'expo-localization';
import Storage from 'expo-sqlite/kv-store';
import { createInstance } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { de } from './locales/de';
import { en } from './locales/en';

/** The languages the app is translated into, each named in its own language. */
export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]['code'];
/** What the user picked in Settings: a language, or `system` to follow the phone's language. */
export type LanguageSetting = 'system' | LanguageCode;

const resources = { en: { translation: en }, de: { translation: de } } satisfies Record<
  LanguageCode,
  { translation: typeof en }
>;

/** Kept in the key-value store (not the library database), so Clear library and imports leave it alone. */
const STORAGE_KEY = 'language';

const isLanguageCode = (value: string | null | undefined): value is LanguageCode =>
  LANGUAGES.some((l) => l.code === value);

/** The phone's first preferred language the app supports, or English. */
export function systemLanguage(): LanguageCode {
  for (const locale of getLocales()) {
    if (isLanguageCode(locale.languageCode)) return locale.languageCode;
  }
  return 'en';
}

export function getLanguageSetting(): LanguageSetting {
  try {
    const stored = Storage.getItemSync(STORAGE_KEY);
    return isLanguageCode(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

const resolve = (setting: LanguageSetting): LanguageCode => (setting === 'system' ? systemLanguage() : setting);

/** Saves the choice and switches the app's texts right away. */
export async function setLanguageSetting(setting: LanguageSetting): Promise<void> {
  if (setting === 'system') Storage.removeItemSync(STORAGE_KEY);
  else Storage.setItemSync(STORAGE_KEY, setting);
  await i18next.changeLanguage(resolve(setting));
}

const i18next = createInstance();

// Initialised at import, synchronously (resources are bundled), so the first screen and the background sync
// task, which runs without any screen, already have their texts.
i18next.use(initReactI18next).init({
  resources,
  lng: resolve(getLanguageSetting()),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  initAsync: false,
});

export const i18n = i18next;
/** Translates outside React components (errors, background sync); components use `useTranslation()`. */
export const t = i18next.t.bind(i18next);
