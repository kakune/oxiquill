import { defineOxiquillConfig } from 'oxiquill/astro';

const basePath = process.env.BASE_PATH;

export default defineOxiquillConfig({
  site: process.env.SITE ?? 'https://oxiquill.local',
  ...(basePath ? { base: basePath } : {}),
  starlight: {
    title: 'Oxiquill',
    description: 'A static documentation workspace for Rust, Python, Haskell, math, diagrams, and media-rich MDX notes.',
    disable404Route: true,
    defaultLocale: 'root',
    locales: {
      root: {
        label: 'English',
        lang: 'en'
      },
      ja: {
        label: '日本語',
        lang: 'ja'
      }
    },
    sidebar: [
      {
        label: 'Overview',
        translations: { ja: '概要' },
        items: [
          { label: 'Oxiquill', slug: 'index' }
        ]
      },
      {
        label: 'Guides',
        translations: { ja: 'ガイド' },
        items: [
          { label: 'Getting Started', translations: { ja: 'はじめに' }, slug: 'guides/getting-started' },
          { label: 'Project Configuration', translations: { ja: 'プロジェクト設定' }, slug: 'guides/project-configuration' },
          { label: 'Python Runtime Assets', translations: { ja: 'Python runtime asset' }, slug: 'guides/python-runtime' },
          { label: 'Support and Security', translations: { ja: 'サポートとセキュリティ' }, slug: 'guides/support-and-security' },
          { label: 'Troubleshooting', translations: { ja: 'トラブルシューティング' }, slug: 'guides/troubleshooting' },
          { label: 'Authoring Guide', translations: { ja: '執筆ガイド' }, slug: 'guides/authoring' },
          { label: 'Templates', translations: { ja: 'テンプレート' }, slug: 'guides/templates' },
          { label: 'Licensing', translations: { ja: 'ライセンス' }, slug: 'guides/licensing' },
          { label: 'Validation', translations: { ja: '検証' }, slug: 'guides/validation' }
        ]
      },
      {
        label: 'Reference',
        translations: { ja: 'リファレンス' },
        items: [
          { label: 'Package API', translations: { ja: 'Package API' }, slug: 'reference/package-api' },
          { label: 'CLI', translations: { ja: 'CLI' }, slug: 'reference/cli' }
        ]
      },
      {
        label: 'Features',
        translations: { ja: '機能' },
        items: [
          { label: 'Interactive Cells', translations: { ja: '実行可能セル' }, slug: 'features/interactive-cells' },
          { label: 'Rich Output', translations: { ja: 'リッチ出力' }, slug: 'features/rich-output' },
          { label: 'Math', translations: { ja: '数式' }, slug: 'features/math' },
          { label: 'Diagrams', translations: { ja: '図' }, slug: 'features/diagrams' },
          { label: 'Media', translations: { ja: 'メディア' }, slug: 'features/media' }
        ]
      },
      {
        label: 'Sample Notes',
        translations: { ja: 'サンプルノート' },
        items: [
          { label: 'Rust Ownership', translations: { ja: 'Rust の所有権' }, slug: 'samples/rust-ownership' },
          { label: 'Logistic Map', translations: { ja: 'ロジスティック写像' }, slug: 'samples/logistic-map' },
          { label: 'Haskell Series', translations: { ja: 'Haskell 数列' }, slug: 'samples/haskell-series' }
        ]
      }
    ]
  }
});
