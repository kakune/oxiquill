import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  framework: { starlight },
  site: 'https://example.com',
  base: '/localized/',
  title: 'Localized',
  missingTranslations: 'omit',
  docRedirects: { '/ja/old-guide/': '/ja/guide/' },
  vite: { ssr: { noExternal: ['@astrojs/starlight'] } },
  starlight: {
    disable404Route: true,
    customCss: ['oxiquill/styles/japanese.css'],
    defaultLocale: 'root',
    locales: {
      root: { label: 'English', lang: 'en' },
      ja: { label: '日本語', lang: 'ja' }
    },
    sidebar: [
      { label: 'Guides', translations: { ja: 'ガイド' }, items: ['index', 'guide', 'english-only', 'wide'] },
      { label: 'Notes', translations: { ja: 'ノート' }, items: ['notes'] }
    ]
  }
});
