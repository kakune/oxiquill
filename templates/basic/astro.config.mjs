import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  framework: { starlight },
  site: 'https://example.com',
  title: 'My Docs',
  starlight: { disable404Route: true },
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
