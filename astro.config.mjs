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
          label: 'Start Here',
          translations: { ja: 'はじめに' },
          items: [
            { label: 'Overview', translations: { ja: '概要' }, slug: 'index' },
            { label: 'Authoring', translations: { ja: '執筆ガイド' }, slug: 'authoring' },
            { label: 'Templates', translations: { ja: 'テンプレート' }, slug: 'templates' }
          ]
        },
        {
          label: 'Feature Examples',
          translations: { ja: '機能例' },
          items: [
            { label: 'Interactive Cells', translations: { ja: '実行可能セル' }, slug: 'interactive-rust' },
            { label: 'Math', translations: { ja: '数式' }, slug: 'math' },
            { label: 'Mermaid', slug: 'mermaid' },
            { label: 'Media', translations: { ja: 'メディア' }, slug: 'media' }
          ]
        },
        {
          label: 'Sample Notes',
          translations: { ja: 'サンプルノート' },
          items: [
            { label: 'Ownership', translations: { ja: '所有権' }, slug: 'notes/rust-basics/ownership' },
            {
              label: 'Logistic Map',
              translations: { ja: 'ロジスティック写像' },
              slug: 'notes/numerical-computing/logistic-map'
            }
          ]
        }
      ]
    })
  ]
});
