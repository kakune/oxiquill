import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  site: 'https://example.com',
  title: 'My Docs',
  sidebar: [
    { label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }
  ]
});
