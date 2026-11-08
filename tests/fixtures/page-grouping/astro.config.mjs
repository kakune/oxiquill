import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

// `custom` selects a function grouping by top-level docs directory.
const grouping = process.env.OXIQUILL_FIXTURE_GROUPING ?? 'page';

export default defineOxiquillConfig({
  framework: { starlight },
  site: 'https://example.com',
  base: '/grouped/',
  title: 'Grouped Rust',
  vite: { ssr: { noExternal: ['@astrojs/starlight'] } },
  rust: { grouping: grouping === 'custom' ? ({ path }) => path.split('/')[0] : grouping },
  starlight: { disable404Route: true },
  sidebar: [{ label: 'Pages', items: ['index', 'first', 'second', 'third'] }]
});
