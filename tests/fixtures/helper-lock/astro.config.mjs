import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  framework: { starlight },
  site: 'https://example.com',
  title: 'Helper lock',
  vite: { ssr: { noExternal: ['@astrojs/starlight'] } },
  rust: { grouping: 'page' },
  starlight: { disable404Route: true },
  sidebar: [{ label: 'Pages', items: ['index', 'first', 'second'] }]
});
