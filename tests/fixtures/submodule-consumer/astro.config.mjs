import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  site: 'https://example.com',
  title: 'Submodule Consumer',
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
