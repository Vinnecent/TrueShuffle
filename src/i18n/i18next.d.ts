import 'i18next';

import type { Translations } from './locales/en';

// Typed keys: t('…') only accepts keys that exist in the English texts.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: Translations };
  }
}
