import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  site: 'https://example.com',
  title: 'Linked Consumer',
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
