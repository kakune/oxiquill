import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

export default defineConfig({
  site: process.env.SITE ?? 'https://oxiquill.local',
  output: 'static',
  markdown: {
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['math', 'mermaid']
    },
    remarkPlugins: [remarkMath],
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
      description: 'A static documentation workspace for executable notes, diagrams, math, and media-rich MDX.',
      defaultLocale: 'root',
      locales: {
        root: {
          label: 'English',
          lang: 'en'
        },
        ja: {
          label: 'Japanese',
          lang: 'ja'
        }
      },
      customCss: ['katex/dist/katex.min.css'],
      sidebar: []
    })
  ]
});
