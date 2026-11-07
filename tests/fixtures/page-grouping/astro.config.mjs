import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  framework: { starlight },
  site: 'https://example.com',
  base: '/grouped/',
  title: 'Grouped Rust',
  vite: { ssr: { noExternal: ['@astrojs/starlight'] } },
  rust: { grouping: process.env.OXIQUILL_FIXTURE_GROUPING ?? 'page' },
  starlight: { disable404Route: true },
  sidebar: [{ label: 'Pages', items: ['index', 'first', 'second', 'third'] }]
});
