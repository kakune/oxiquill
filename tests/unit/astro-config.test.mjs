// @vitest-environment node

import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';

vi.mock('astro/config', () => ({
  defineConfig: (config) => config
}));

vi.mock('@astrojs/preact', () => ({
  default: () => ({ hooks: {}, name: '@astrojs/preact' })
}));

vi.mock('@astrojs/starlight', () => ({
  default: () => ({ hooks: {}, name: '@astrojs/starlight' })
}));

const { defineOxiquillConfig } = await import('../../packages/oxiquill/src/astro/index.ts');
const linkedConsumerRoot = new URL('../fixtures/linked-consumer/', import.meta.url);
const tempRoot = pathToFileURL(os.tmpdir());

function integrationNames(config) {
  return config.integrations.flat().map((integration) => integration.name);
}

function runConfigSetup(config, root = tempRoot) {
  const integration = config.integrations.flat().find((entry) => entry.name === 'oxiquill');
  let update;

  integration.hooks['astro:config:setup']({
    addWatchFile: vi.fn(),
    config: { root },
    updateConfig: (value) => {
      update = value;
    }
  });

  return update;
}

async function resolveWithVite(update, ids) {
  const { server: serverConfig = {}, ...viteConfig } = update.vite;
  const server = await createServer({
    ...viteConfig,
    root: fileURLToPath(linkedConsumerRoot),
    cacheDir: path.join(os.tmpdir(), 'oxiquill-vitest-vite-cache'),
    logLevel: 'silent',
    server: {
      ...serverConfig,
      middlewareMode: true
    }
  });

  try {
    const pluginContainer = server.environments?.client?.pluginContainer ?? server.pluginContainer;
    const resolvedEntries = await Promise.all(
      ids.map(async (id) => [id, (await pluginContainer.resolveId(id))?.id])
    );

    return Object.fromEntries(resolvedEntries);
  } finally {
    await server.close();
  }
}

describe('defineOxiquillConfig', () => {
  it('composes package-owned Astro integrations by default', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    expect(integrationNames(config)).toContain('oxiquill');
    expect(integrationNames(config)).toContain('@astrojs/preact');
    expect(integrationNames(config)).toContain('@astrojs/starlight');
  });

  it('passes top-level shorthand options to Starlight', () => {
    const starlight = vi.fn(() => ({ hooks: {}, name: 'custom-starlight' }));

    defineOxiquillConfig({
      description: 'Docs description',
      framework: { starlight },
      sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }],
      title: 'Docs'
    });

    expect(starlight).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Docs description',
        sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }],
        title: 'Docs'
      })
    );
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

  it('allows linked package sources and package-managed dependencies in Vite dev server', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs',
      vite: {
        server: {
          fs: {
            allow: ['/already-allowed']
          }
        }
      }
    });

    const update = runConfigSetup(config);
    const allow = update.vite.server.fs.allow;

    expect(allow).toContain('/already-allowed');
    expect(allow).toContain(realpathSync(fileURLToPath(tempRoot)));
    expect(allow).toContain(realpathSync('packages/oxiquill'));
    expect(allow).toContain(realpathSync('node_modules'));
    expect(allow.some((entry) => entry.includes('node_modules/.pnpm/katex'))).toBe(true);
    expect(allow.some((entry) => entry.includes('node_modules/.pnpm/@astrojs+preact'))).toBe(true);
    expect(allow.some((entry) => entry.includes('node_modules/.pnpm/aria-query'))).toBe(true);
  });

  it('resolves package-managed dependencies through Vite from linked consumers', async () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, linkedConsumerRoot);
    const resolved = await resolveWithVite(update, [
      'preact/hooks',
      '@preact/signals',
      'aria-query',
      'html-escaper',
      'astro/app',
      'astro/content/runtime',
      'astro/jsx-runtime',
      'astro/loaders',
      'astro/runtime/client/dev-toolbar/entrypoint.js',
      'astro/runtime/server/index.js'
    ]);

    expect(resolved['preact/hooks']).toEqual(expect.any(String));
    expect(resolved['@preact/signals']).toEqual(expect.any(String));
    expect(resolved['aria-query']).toEqual(expect.any(String));
    expect(resolved['html-escaper']).toEqual(expect.any(String));
    expect(resolved['astro/app']).toEqual(expect.any(String));
    expect(resolved['astro/content/runtime']).toEqual(expect.any(String));
    expect(resolved['astro/jsx-runtime']).toEqual(expect.any(String));
    expect(resolved['astro/loaders']).toEqual(expect.any(String));
    expect(resolved['astro/runtime/client/dev-toolbar/entrypoint.js']).toEqual(expect.any(String));
    expect(resolved['astro/runtime/server/index.js']).toEqual(expect.any(String));
  });
});
