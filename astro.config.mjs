import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { fileURLToPath } from 'node:url';
import remarkInteractiveCells from './src/lib/doc-runtime/remark-interactive-cells.mjs';
import remarkMermaidDiagrams from './src/lib/doc-runtime/remark-mermaid-diagrams.mjs';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  site: process.env.SITE ?? 'https://oxiquill.local',
  output: 'static',
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['math', 'mermaid']
    },
    remarkPlugins: [
      remarkMath,
      [remarkInteractiveCells, { root: projectRoot }],
      [remarkMermaidDiagrams, { root: projectRoot }]
    ],
    rehypePlugins: [rehypeKatex]
  },
  vite: {
    worker: {
      format: 'es'
    },
    build: {
      chunkSizeWarningLimit: 650
    }
  },
  integrations: [
    preact(),
    starlight({
      title: 'Oxiquill',
      description: 'A static documentation workspace for Rust, Python, math, diagrams, and media-rich MDX notes.',
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
      customCss: ['katex/dist/katex.min.css', './src/styles/custom.css'],
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
            { label: 'Authoring Guide', translations: { ja: '執筆ガイド' }, slug: 'guides/authoring' },
            { label: 'Templates', translations: { ja: 'テンプレート' }, slug: 'guides/templates' },
            { label: 'Validation', translations: { ja: '検証' }, slug: 'guides/validation' }
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
            { label: 'Logistic Map', translations: { ja: 'ロジスティック写像' }, slug: 'samples/logistic-map' }
          ]
        }
      ]
    })
  ]
});
