// @vitest-environment node

import { createRequire } from 'node:module';
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

const { defineOxiquillConfig: definePackageConfig, oxiquillIntegration } =
  await import('../../packages/oxiquill/src/astro/index.ts');
const { readOxiquillMetadata } = await import('../../packages/oxiquill/src/config/metadata.mjs');
const { canonicalPath } = await import('../../packages/oxiquill/src/config/paths.mjs');
const requireFromPackage = createRequire(path.resolve(process.cwd(), 'packages/oxiquill/package.json'));
const requireFromStarlight = createRequire(requireFromPackage.resolve('@astrojs/starlight'));
const { default: astroMdx } = await import(pathToFileURL(requireFromStarlight.resolve('@astrojs/mdx')).href);
const linkedConsumerRoot = new URL('../fixtures/linked-consumer/', import.meta.url);
const tempRoot = pathToFileURL(canonicalPath(os.tmpdir()));
const preactExportSpecifiers = [
  'preact',
  'preact/jsx-runtime',
  'preact/jsx-dev-runtime',
  'preact/hooks',
  'preact/debug',
  'preact/devtools'
];
const preactRendererExportSpecifiers = [
  'preact-render-to-string',
  'preact-render-to-string/jsx',
  'preact-render-to-string/stream',
  'preact-render-to-string/stream-node'
];

function defineOxiquillConfig(options) {
  return definePackageConfig({
    ...options,
    framework: {
      starlight: () => ({ hooks: {}, name: '@astrojs/starlight' }),
      ...options.framework
    }
  });
}

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
    const resolvedEntries = await Promise.all(ids.map(async (id) => [id, (await pluginContainer.resolveId(id))?.id]));

    return Object.fromEntries(resolvedEntries);
  } finally {
    await server.close();
  }
}

async function compileMdxWithAstro(update, source, filePath) {
  const integration = astroMdx();
  const config = {
    markdown: update.markdown,
    srcDir: new URL('./src/', linkedConsumerRoot)
  };
  let vitePlugins;

  await integration.hooks['astro:config:setup']({
    addContentEntryType: vi.fn(),
    addPageExtension: vi.fn(),
    addRenderer: vi.fn(),
    config,
    updateConfig: (value) => {
      vitePlugins = value.vite.plugins;
    }
  });
  integration.hooks['astro:config:done']({ config, logger: { warn: vi.fn() } });

  const plugin = vitePlugins.find(({ name }) => name === '@mdx-js/rolldown');
  plugin.configResolved({ build: { sourcemap: false }, plugins: [] });
  return plugin.transform.handler(source, filePath);
}

describe('defineOxiquillConfig', () => {
  it('requires consumers to load the Starlight integration directly', () => {
    expect(() => definePackageConfig({ sidebar: [], title: 'Docs' })).toThrow(
      'requires framework.starlight to be an Astro integration factory'
    );
  });

  it('retains frozen internal metadata without adding enumerable config fields', () => {
    const config = defineOxiquillConfig({
      python: { offline: true, packageMirror: 'https://packages.example/pyodide' },
      sidebar: [],
      title: 'Docs'
    });
    const integration = config.integrations.flat().find((entry) => entry.name === 'oxiquill');

    expect(readOxiquillMetadata(config)).toMatchObject({ kind: 'config' });
    expect(readOxiquillMetadata(integration)).toMatchObject({
      kind: 'integration',
      python: { offline: true, packageMirror: 'https://packages.example/pyodide/' }
    });
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
    expect(() =>
      runConfigSetup(
        defineOxiquillConfig({
          publicDir: 'astro-public',
          paths: { publicDir: 'oxiquill-public' },
          sidebar: [],
          title: 'Docs'
        })
      )
    ).toThrow('Conflicting project paths: publicDir');
  });

  it('composes package-owned Astro integrations by default', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);

    expect(integrationNames(config)).toContain('oxiquill');
    expect(integrationNames(config)).toContain('@astrojs/preact');
    expect(integrationNames(config)).toContain('@astrojs/starlight');
    expect(config.compressHTML).toBe(true);
    expect(update.markdown.processor.name).toBe('unified');
  });

  it('configures Oxiquill and consumer plugins on the unified Markdown processor', () => {
    const remarkPlugin = () => {};
    const rehypePlugin = () => {};
    const config = defineOxiquillConfig({
      markdown: {
        rehypePlugins: [rehypePlugin],
        remarkPlugins: [remarkPlugin]
      },
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);
    const remarkPlugins = update.markdown.processor.options.remarkPlugins;
    const rehypePlugins = update.markdown.processor.options.rehypePlugins;

    expect(remarkPlugins.map(pluginName)).toEqual([
      'remarkMath',
      'remarkPublicAssetBase',
      'remarkInteractiveCells',
      'remarkMermaidDiagrams',
      'remarkPlugin'
    ]);
    expect(rehypePlugins.map(pluginName)).toEqual(['rehypeKatex', 'rehypePlugin']);
    expect(update.markdown).not.toHaveProperty('remarkPlugins');
    expect(update.markdown).not.toHaveProperty('rehypePlugins');
  });

  it('compiles MDX whose author bindings collide with every preferred runtime alias', async () => {
    const config = defineOxiquillConfig({ sidebar: [], title: 'Docs' });
    const update = runConfigSetup(config);
    const rendered = await compileMdxWithAstro(
      update,
      `export const __OxiquillInteractiveCell = () => null;
export const __OxiquillMermaidDiagram = () => null;
export const __oxiquillCell0 = {};

\`\`\`rust
//| id: collision
println!("ok");
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\``,
      path.join(fileURLToPath(linkedConsumerRoot), 'content', 'docs', 'collision.mdx')
    );

    expect(rendered.code).toContain('__OxiquillInteractiveCell1');
    expect(rendered.code).toContain('__OxiquillMermaidDiagram1');
    expect(rendered.code).toContain('__oxiquillCell01');
  });

  it('renders overlapping public media bases through the configured Markdown processor', async () => {
    const config = defineOxiquillConfig({ base: '/media', sidebar: [], title: 'Docs' });
    const update = runConfigSetup(config);
    const renderer = await update.markdown.processor.createRenderer(update.markdown);
    const rendered = await renderer.render('![Sample](/media/examples/sample.png)\n\n[Guide](/media/docs/guide.pdf)', {
      fileURL: pathToFileURL(path.join(os.tmpdir(), 'oxiquill-render-fixture', 'content', 'docs', 'page.md'))
    });

    expect(rendered.code).toContain('src="/media/media/examples/sample.png"');
    expect(rendered.code).toContain('href="/media/media/docs/guide.pdf"');
  });

  it.each([
    ['disabled highlighting', false],
    ['Prism highlighting', 'prism'],
    ['Shiki shorthand highlighting', 'shiki']
  ])('preserves %s', (_label, syntaxHighlight) => {
    const config = defineOxiquillConfig({
      markdown: { syntaxHighlight },
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);

    expect(update.markdown.syntaxHighlight).toBe(syntaxHighlight);
  });

  it('merges required languages into Shiki object exclusions without dropping consumer fields', () => {
    const config = defineOxiquillConfig({
      markdown: {
        syntaxHighlight: { excludeLangs: ['custom', 'math'], type: 'shiki' }
      },
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);

    expect(update.markdown.syntaxHighlight).toEqual({
      excludeLangs: ['custom', 'math', 'mermaid'],
      type: 'shiki'
    });
  });

  it('uses Shiki with Oxiquill exclusions when syntax highlighting is not configured', () => {
    const update = runConfigSetup(defineOxiquillConfig({ sidebar: [], title: 'Docs' }));

    expect(update.markdown.syntaxHighlight).toEqual({
      excludeLangs: ['math', 'mermaid'],
      type: 'shiki'
    });
  });

  it('preserves supported Astro rendering and Markdown fields', () => {
    const image = { domains: ['images.example.com'] };
    const remarkRehype = { footnoteLabel: 'Notes' };
    const shikiConfig = { theme: 'github-light' };
    const smartypants = { dashes: 'oldschool' };
    const config = defineOxiquillConfig({
      compressHTML: 'jsx',
      markdown: { gfm: false, image, remarkRehype, shikiConfig, smartypants },
      sidebar: [],
      title: 'Docs'
    });
    const update = runConfigSetup(config);

    expect(config.compressHTML).toBe('jsx');
    expect(update.markdown).toMatchObject({ image, shikiConfig });
    expect(update.markdown.processor.options).toMatchObject({
      gfm: false,
      remarkRehype,
      smartypants
    });
  });

  it('rejects a custom Markdown processor before configuration setup', () => {
    const markdown = { processor: { createRenderer: vi.fn(), name: 'custom', options: {} } };
    const expectedError = new TypeError(
      'Oxiquill does not support markdown.processor because it owns the Markdown processor pipeline required for its transforms.'
    );

    expect(() => defineOxiquillConfig({ markdown, sidebar: [], title: 'Docs' })).toThrow(expectedError);
    expect(() => oxiquillIntegration({ markdown })).toThrow(expectedError);
  });

  it('installs package-owned main and worker bundle reporters', () => {
    const update = runConfigSetup(defineOxiquillConfig({ sidebar: [], title: 'Docs' }));
    const mainPlugins = update.vite.plugins.map((plugin) => plugin.name);
    const workerPlugins = update.vite.worker.plugins().map((plugin) => plugin.name);

    expect(mainPlugins).toContain('oxiquill-browser-bundle-main');
    expect(workerPlugins).toContain('oxiquill-browser-bundle-worker');
    expect(update.vite.build.chunkSizeWarningLimit).toBe(675);
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

  it('enables the desktop table-of-contents toggle by default and preserves component overrides', () => {
    const starlight = vi.fn(() => ({ hooks: {}, name: 'custom-starlight' }));

    defineOxiquillConfig({
      framework: { starlight },
      starlight: {
        components: {
          PageFrame: './CustomPageFrame.astro',
          TableOfContents: './CustomTableOfContents.astro'
        }
      }
    });

    expect(starlight).toHaveBeenCalledWith(
      expect.objectContaining({
        components: {
          PageFrame: './CustomPageFrame.astro',
          TableOfContents: './CustomTableOfContents.astro',
          TwoColumnContent: 'oxiquill/components/starlight/TwoColumnContent'
        }
      })
    );
  });

  it('allows consumers to disable or replace the desktop table-of-contents toggle', () => {
    const disabledStarlight = vi.fn(() => ({ hooks: {}, name: 'disabled-starlight' }));
    defineOxiquillConfig({ desktopTableOfContentsToggle: false, framework: { starlight: disabledStarlight } });
    expect(disabledStarlight).toHaveBeenCalledWith(
      expect.objectContaining({
        components: { PageFrame: 'oxiquill/components/starlight/PageFrame' }
      })
    );

    const overriddenStarlight = vi.fn(() => ({ hooks: {}, name: 'overridden-starlight' }));
    defineOxiquillConfig({
      framework: { starlight: overriddenStarlight },
      starlight: { components: { TwoColumnContent: './CustomTwoColumnContent.astro' } }
    });
    expect(overriddenStarlight).toHaveBeenCalledWith(
      expect.objectContaining({
        components: {
          PageFrame: 'oxiquill/components/starlight/PageFrame',
          TwoColumnContent: './CustomTwoColumnContent.astro'
        }
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
    expect(allow).toContain(canonicalPath(fileURLToPath(tempRoot)));
    expect(allow).toContain(canonicalPath('packages/oxiquill'));
    expect(allow).toContain(canonicalPath('node_modules'));
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/katex'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/@astrojs+preact'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/@bjorn3+browser_wasi_shim'))).toBe(true);
    expect(normalizedAllow.some((entry) => entry.includes('node_modules/.pnpm/aria-query'))).toBe(true);
  });

  it('aliases the Preact runtime when the workspace does not expose a direct install', () => {
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

    for (const id of preactRendererExportSpecifiers) {
      const replacement = aliasReplacementFor(update.vite.resolve.alias, id);

      expect(replacement, id).toEqual(expect.any(String));
      expect(replacement.replaceAll('\\', '/'), id).toContain('/node_modules/preact-render-to-string/');
    }
  });

  it('shares a directly installed workspace Preact runtime during SSR', async () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, new URL('../../nested/astro-root/', import.meta.url));

    for (const id of preactExportSpecifiers) {
      expect(aliasReplacementFor(update.vite.resolve.alias, id), id).toBeUndefined();
    }

    const resolver = update.vite.plugins.find((plugin) => plugin.name === 'oxiquill-dependency-resolver');
    const resolve = vi.fn();

    await expect(resolver.resolveId.call({ resolve }, 'preact/hooks', undefined, {})).resolves.toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('bundles the complete Preact SSR runtime with compiled Oxiquill', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs'
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    expect(update.vite.ssr.noExternal).toEqual(
      expect.arrayContaining(['@astrojs/preact', 'oxiquill', 'preact', 'preact-render-to-string'])
    );
    expect(update.vite.resolve.dedupe).toEqual(
      expect.arrayContaining(['@preact/signals', 'preact', 'preact-render-to-string'])
    );
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
    expect(update.vite.ssr.noExternal).toEqual(
      expect.arrayContaining([
        'consumer-package',
        consumerNoExternal,
        '@astrojs/preact',
        'oxiquill',
        'preact',
        'preact-render-to-string'
      ])
    );
    expect(update.vite.resolve.dedupe).toEqual(
      expect.arrayContaining(['consumer-runtime', '@preact/signals', 'preact', 'preact-render-to-string'])
    );
  });

  it('merges Mermaid into consumer Vite dependency optimization without duplicates', () => {
    const config = defineOxiquillConfig({
      sidebar: [],
      title: 'Docs',
      vite: {
        optimizeDeps: {
          entries: ['consumer-entry.ts'],
          exclude: ['consumer-runtime'],
          include: ['consumer-runtime', 'oxiquill > mermaid', 'oxiquill > mermaid'],
          noDiscovery: true
        }
      }
    });

    const update = runConfigSetup(config, linkedConsumerRoot);

    expect(update.vite.optimizeDeps).toEqual({
      entries: ['consumer-entry.ts'],
      exclude: ['consumer-runtime'],
      include: ['consumer-runtime', 'oxiquill > mermaid'],
      noDiscovery: true
    });
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

      expect(update.vite.ssr.noExternal).toEqual(
        expect.arrayContaining([noExternal, '@astrojs/preact', 'oxiquill', 'preact', 'preact-render-to-string'])
      );
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
      ...preactRendererExportSpecifiers,
      '@preact/signals',
      '@bjorn3/browser_wasi_shim',
      'aria-query',
      'html-escaper',
      'mermaid',
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

    for (const id of preactRendererExportSpecifiers) {
      expect(resolved[id], id).toEqual(expect.any(String));
    }

    expect(resolved['@preact/signals']).toEqual(expect.any(String));
    expect(resolved['aria-query']).toEqual(expect.any(String));
    expect(resolved['html-escaper']).toEqual(expect.any(String));
    expect(resolved.mermaid).toEqual(expect.any(String));
    expect(resolved['astro/app']).toEqual(expect.any(String));
    expect(resolved['astro/content/runtime']).toEqual(expect.any(String));
    expect(resolved['astro/jsx-runtime']).toEqual(expect.any(String));
    expect(resolved['astro/loaders']).toEqual(expect.any(String));
    expect(resolved['astro/runtime/client/dev-toolbar/entrypoint.js']).toEqual(expect.any(String));
    expect(resolved['astro/runtime/server/index.js']).toEqual(expect.any(String));
  });
});

function pluginName(plugin) {
  return (Array.isArray(plugin) ? plugin[0] : plugin).name;
}
