import type { TranslationIndex } from '../../../packages/oxiquill/src/lib/starlight/translations';

export const paths: readonly unknown[] = [];
export const translations: TranslationIndex = {
  routeIds: new Set(['', 'guide', 'ja', 'ja/guide']),
  fallbackRouteIds: new Set(['ja/english-only']),
  locales: { root: { label: 'English', lang: 'en' }, ja: { label: '日本語', lang: 'ja' } },
  defaultLocale: undefined,
  pagination: true,
  trailingSlash: 'ignore',
  base: '/'
};
