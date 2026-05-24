import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  site: 'https://example.com',
  framework: { preact, starlight },
  starlight: {
    title: 'Submodule Consumer',
    sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
  }
});
