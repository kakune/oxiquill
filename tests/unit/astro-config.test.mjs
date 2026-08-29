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
const { readOxiquillMetadata } = await import('../../packages/oxiquill/src/config/metadata.mjs');
const linkedConsumerRoot = new URL('../fixtures/linked-consumer/', import.meta.url);
const tempRoot = pathToFileURL(os.tmpdir());
const preactExportSpecifiers = [
  'preact',
  'preact/jsx-runtime',
  'preact/jsx-dev-runtime',
  'preact/hooks',
  'preact/debug',
  'preact/devtools'
];

function integrationNames(config) {
  return config.integrations.flat().map((integration) => integration.name);
}

function aliasReplacementFor(alias, id) {
  const entries = Array.isArray(alias)
    ? alias
    : Object.entries(alias ?? {}).map(([find, replacement]) => ({ find, replacement }));

  for (const { find, replacement } of entries) {
    if (typeof find === 'string' && find === id) return replacement;
    if (find instanceof RegExp) {
      find.lastIndex = 0;
      if (find.test(id)) return replacement;
    }
  }

  return undefined;
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
  it('retains frozen internal metadata without adding enumerable config fields', () => {
    const config = defineOxiquillConfig({ sidebar: [], title: 'Docs' });
    const integration = config.integrations.flat().find((entry) => entry.name === 'oxiquill');

    expect(readOxiquillMetadata(config)).toMatchObject({ kind: 'config' });
    expect(readOxiquillMetadata(integration)).toMatchObject({ kind: 'integration' });
    expect(Object.isFrozen(readOxiquillMetadata(config))).toBe(true);
    expect(Object.keys(config)).not.toContain('oxiquill');
  });

  it('uses configured Oxiquill paths in the Astro setup hook and rejects conflicts', () => {
    const config = defineOxiquillConfig({
      paths: {
        cacheDir: 'state',
        docsDir: 'written-docs',
        generatedDir: 'runtime'
      },
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);

    expect(path.resolve(fileURLToPath(update.cacheDir))).toBe(path.join(fileURLToPath(tempRoot), 'state'));
    expect(() => runConfigSetup(defineOxiquillConfig({
      publicDir: 'astro-public',
      paths: { publicDir: 'oxiquill-public' },
      sidebar: [],
      title: 'Docs'
    }))).toThrow('Conflicting project paths: publicDir');
  });

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
    const normalizedAllow = allow.map((entry) => entry.replaceAll('\\', '/'));

    expect(allow).toContain('/already-allowed');
    expect(allow).toContain(realpathSync(fileURLToPath(tempRoot)));
    expect(allow).toContain(realpathSync('packages/oxiquill'));
    expect(allow).toContain(realpathSync('node_modules'));
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/katex'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/@astrojs+preact'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/@bjorn3+browser_wasi_shim'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/aria-query'))).toBe(true);
  });

  it('aliases Preact exports needed by Astro Preact dependency optimization', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    for (const id of preactExportSpecifiers) {
      const replacement = aliasReplacementFor(update.vite.resolve.alias, id);

      expect(replacement, id).toEqual(expect.any(String));
      expect(replacement.replaceAll('\\', '/'), id).toContain('/node_modules/preact/');
    }
  });

  it('transforms installed Oxiquill TSX with the Preact JSX runtime', async () => {
    const config = defineOxiquillConfig({ sidebar: [], title: 'Docs' });
    const update = runConfigSetup(config, linkedConsumerRoot);
    const plugin = update.vite.plugins.find((entry) => entry.name === 'oxiquill-preact-jsx');
    const componentPath = fileURLToPath(new URL(
      '../../packages/oxiquill/src/components/doc-runtime/InteractiveCell.tsx',
      import.meta.url
    ));

    const transformed = await plugin.transform('export default () => <section>ok</section>;', componentPath);
    expect(transformed.code).toContain('preact/jsx-runtime');
    await expect(plugin.transform('export default () => <div />;', '/consumer/Component.tsx'))
      .resolves.toBeUndefined();
  });

  it('keeps Oxiquill Preact runtime dependencies bundled for dev SSR', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    expect(update.vite.ssr.noExternal).toEqual(expect.arrayContaining([
      '@astrojs/preact',
      'preact',
      'preact-render-to-string'
    ]));
    expect(update.vite.resolve.dedupe).toEqual(expect.arrayContaining([
      '@preact/signals',
      'preact'
    ]));
  });

  it('merges consumer Vite SSR and dedupe settings with Oxiquill defaults', () => {
    const consumerNoExternal = /^consumer-/;
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs',
      vite: {
        resolve: {
          dedupe: ['consumer-runtime']
        },
        ssr: {
          external: ['external-runtime'],
          noExternal: ['consumer-package', consumerNoExternal]
        }
      }
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    expect(update.vite.ssr.external).toEqual(['external-runtime']);
    expect(update.vite.ssr.noExternal).toEqual(expect.arrayContaining([
      'consumer-package',
      consumerNoExternal,
      '@astrojs/preact',
      'preact',
      'preact-render-to-string'
    ]));
    expect(update.vite.resolve.dedupe).toEqual(expect.arrayContaining([
      'consumer-runtime',
      '@preact/signals',
      'preact'
    ]));
  });

  it('normalizes singular consumer SSR noExternal entries when merging Oxiquill defaults', () => {
    for (const noExternal of ['consumer-package', /^consumer-/]) {
      const config = defineOxiquillConfig({
        sidebar: [],
        title: 'Docs',
        vite: {
          ssr: { noExternal }
        }
      });

      const update = runConfigSetup(config, linkedConsumerRoot);

      expect(update.vite.ssr.noExternal).toEqual(expect.arrayContaining([
        noExternal,
        '@astrojs/preact',
        'preact',
        'preact-render-to-string'
      ]));
    }
  });

  it('preserves vite.ssr.noExternal true semantics', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs',
      vite: {
        ssr: { noExternal: true }
      }
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    expect(update.vite.ssr.noExternal).toBe(true);
  });

  it('resolves package-managed dependencies through Vite from linked consumers', async () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, linkedConsumerRoot);
    const resolved = await resolveWithVite(update, [
      ...preactExportSpecifiers,
      '@preact/signals',
      '@bjorn3/browser_wasi_shim',
      'aria-query',
      'html-escaper',
      'astro/app',
      'astro/content/runtime',
      'astro/jsx-runtime',
      'astro/loaders',
      'astro/runtime/client/dev-toolbar/entrypoint.js',
      'astro/runtime/server/index.js'
    ]);

    for (const id of preactExportSpecifiers) {
      expect(resolved[id], id).toEqual(expect.any(String));
    }

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
