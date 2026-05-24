// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

vi.mock('astro/config', () => ({
  defineConfig: (config) => config
}));

vi.mock('@astrojs/preact', () => ({
  default: () => ({ hooks: {}, name: '@astrojs/preact' })
}));

vi.mock('@astrojs/starlight', () => ({
  default: () => ({ hooks: {}, name: '@astrojs/starlight' })
}));

const { defineOxiquillConfig } = await import('../../packages/oxiquill/src/astro/index.mjs');

function integrationNames(config) {
  return config.integrations.flat().map((integration) => integration.name);
}

describe('defineOxiquillConfig', () => {
  it('composes package-owned Astro integrations by default', () => {
    const config = defineOxiquillConfig({
      starlight: {
        sidebar: [],
        title: 'Docs'
      }
    });

    expect(integrationNames(config)).toContain('oxiquill');
    expect(integrationNames(config)).toContain('@astrojs/preact');
    expect(integrationNames(config)).toContain('@astrojs/starlight');
  });

  it('keeps explicit integration factory overrides for tests and advanced consumers', () => {
    const preact = vi.fn(() => ({ hooks: {}, name: 'custom-preact' }));
    const starlight = vi.fn(() => ({ hooks: {}, name: 'custom-starlight' }));

    const config = defineOxiquillConfig({
      framework: { preact, starlight },
      starlight: {
        sidebar: [],
        title: 'Docs'
      }
    });

    expect(integrationNames(config)).toEqual(['oxiquill', 'custom-preact', 'custom-starlight']);
    expect(starlight).toHaveBeenCalledWith(expect.objectContaining({ title: 'Docs' }));
  });
});
