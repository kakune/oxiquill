// @vitest-environment node

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOxiquillIntegrationMetadata } from '../../packages/oxiquill/src/config/metadata.mjs';
import {
  loadOxiquillProjectConfig,
  resolveAstroConfigFile,
  resolveOxiquillProjectConfig
} from '../../packages/oxiquill/src/config/project-config.mjs';
import { canonicalPath, normalizePath } from '../../packages/oxiquill/src/config/paths.mjs';

const temporaryDirectories = [];
const astroModuleUrl = new URL('../../packages/oxiquill/src/astro/index.ts', import.meta.url).href;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('Oxiquill project configuration', () => {
  it('resolves immutable defaults from one project root', () => {
    const root = path.resolve('/repo');
    const projectConfig = resolveProject({ root });

    expect(projectConfig).toMatchObject({
      cwd: root,
      paths: {
        workspaceRoot: root,
        docsDir: path.join(root, 'content/docs'),
        cratesDir: path.join(root, 'crates'),
        cacheDir: path.join(root, '.oxiquill'),
        downloadCacheDir: path.join(root, '.cache/oxiquill/downloads/v1'),
        generatedDir: path.join(root, '.oxiquill/generated'),
        outDir: path.join(root, 'dist'),
        publicDir: path.join(root, 'public'),
        publicAssetsDir: path.join(root, 'public/oxiquill')
      },
      python: { offline: false, preload: false }
    });
    expect(Object.isFrozen(projectConfig)).toBe(true);
    expect(Object.isFrozen(projectConfig.paths)).toBe(true);
    expect(Object.isFrozen(projectConfig.astroConfigArgs)).toBe(true);
  });

  it('resolves nested relative, absolute, file URL, and space-containing paths against their parents', () => {
    const root = path.resolve('/repo with spaces');
    const absoluteCrates = path.join(root, 'absolute crates');
    const projectConfig = resolveProject({
      root,
      astro: {
        cacheDir: 'state cache',
        outDir: 'site output',
        publicDir: 'site public'
      },
      paths: {
        cratesDir: absoluteCrates,
        docsDir: pathToFileURL(path.join(root, 'written docs')),
        downloadCacheDir: pathToFileURL(path.join(root, 'persistent downloads')),
        generatedDir: 'runtime generated',
        licensesPublicDir: 'legal notices',
        publicAssetsDir: 'runtime assets',
        rustWasmPublicDir: 'rust output'
      }
    });

    expect(projectConfig.paths).toMatchObject({
      cratesDir: absoluteCrates,
      docsDir: path.join(root, 'written docs'),
      downloadCacheDir: path.join(root, 'persistent downloads'),
      generatedDir: path.join(root, 'state cache/runtime generated'),
      licensesPublicDir: path.join(root, 'site public/runtime assets/legal notices'),
      publicAssetsDir: path.join(root, 'site public/runtime assets'),
      rustWasmPublicDir: path.join(root, 'site public/runtime assets/rust output')
    });
  });

  it('normalizes Windows separators for generated URLs and identifiers', () => {
    expect(normalizePath('C:\\workspace\\public\\oxiquill assets')).toBe('C:/workspace/public/oxiquill assets');
  });

  it.runIf(process.platform === 'win32')('treats Windows path casing aliases as the same resolved path', async () => {
    const root = await temporaryDirectory();
    expect(() =>
      resolveProject({
        astro: { cacheDir: 'STATE', outDir: 'OUTPUT' },
        paths: { cacheDir: 'state' },
        root
      })
    ).not.toThrow();
    expect(() => resolveProject({ astro: { cacheDir: 'OUTPUT', outDir: 'output' }, root })).toThrow(
      'it is equal to outDir'
    );
    expect(() => resolveProject({ astro: { outDir: '.GIT' }, root })).toThrow('Git repository metadata');
  });

  it('accepts equivalent explicit paths and reports conflicting fields', () => {
    const root = path.resolve('/repo');
    expect(() =>
      resolveProject({
        root,
        astro: { publicDir: './public-assets' },
        paths: { publicDir: 'nested/../public-assets' }
      })
    ).not.toThrow();

    expect(() =>
      resolveProject({
        root,
        astro: { cacheDir: '.astro-cache' },
        paths: { cacheDir: '.runtime-cache' }
      })
    ).toThrow(
      `Conflicting project paths: cacheDir resolves to ${path.join(root, '.astro-cache')}, ` +
        `but paths.cacheDir resolves to ${path.join(root, '.runtime-cache')}.`
    );
  });

  it('normalizes Python mirror and offline settings before runtime generation', () => {
    const root = path.resolve('/repo');
    const projectConfig = resolveProject({
      python: { offline: true, packageMirror: new URL('https://packages.example/pyodide') },
      root
    });

    expect(projectConfig.python).toEqual({
      offline: true,
      preload: false,
      packageMirror: 'https://packages.example/pyodide/'
    });
    expect(Object.isFrozen(projectConfig.python)).toBe(true);
    expect(() => resolveProject({ python: { offline: 'yes' }, root })).toThrow('python.offline must be a boolean');
    expect(() => resolveProject({ python: { packageMirror: 'file:///packages' }, root })).toThrow(
      'python.packageMirror must be an absolute HTTP(S) URL'
    );
    expect(() => resolveProject({ python: { packageMirror: 'https://user@example.com/' }, root })).toThrow(
      'must not contain credentials'
    );
    expect(() => resolveProject({ python: { unexpected: true }, root })).toThrow('Unknown python option');
  });

  it('canonicalizes symlinked ancestors before comparing explicit settings', async () => {
    const root = await temporaryDirectory();
    const actual = path.join(root, 'actual');
    const linked = path.join(root, 'linked');
    await mkdir(actual);
    await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');

    const projectConfig = resolveProject({
      root,
      astro: { publicDir: path.join(actual, 'public') },
      paths: { publicDir: path.join(linked, 'public') }
    });

    expect(projectConfig.paths.publicDir).toBe(path.join(actual, 'public'));
  });

  it('rejects malformed and broad owned paths before work begins', () => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({ root, paths: { docsDir: '' } })).toThrow('docsDir must not be empty');
    expect(() => resolveProject({ root, paths: { docsDir: new URL('https://example.com/docs') } })).toThrow(
      'docsDir must be a path string or file URL'
    );
    expect(() => resolveProject({ root, astro: { cacheDir: '.' } })).toThrow('Unsafe path cacheDir');
    expect(() => resolveProject({ root, paths: { publicAssetsDir: '..' } })).toThrow(
      'Unsafe path paths.publicAssetsDir'
    );
    expect(() => resolveProject({ root, paths: { downloadCacheDir: '../shared-cache' } })).toThrow(
      'Unsafe path paths.downloadCacheDir'
    );
    expect(() => resolveProject({ root, paths: { downloadCacheDir: '.oxiquill/downloads' } })).toThrow(
      'cacheDir at ' + path.join(root, '.oxiquill') + ': it is an ancestor of paths.downloadCacheDir'
    );
  });

  it.each([
    {
      conflict: 'docsDir (authored documentation input)',
      name: 'cacheDir containing docsDir',
      options: { astro: { cacheDir: 'content' } },
      relationship: 'an ancestor of'
    },
    {
      conflict: 'cratesDir (authored helper-crate input)',
      name: 'outDir equal to cratesDir',
      options: { astro: { outDir: 'crates' } },
      relationship: 'equal to'
    },
    {
      conflict: 'paths.publicDir (authored public asset root)',
      name: 'outDir equal to publicDir',
      options: { astro: { outDir: 'public' } },
      relationship: 'equal to'
    },
    {
      conflict: '.git (Git repository metadata)',
      name: 'cacheDir equal to Git metadata',
      options: { astro: { cacheDir: '.git' } },
      relationship: 'equal to'
    },
    {
      conflict: 'node_modules (installed package dependencies)',
      name: 'outDir equal to installed dependencies',
      options: { astro: { outDir: 'node_modules' } },
      relationship: 'equal to'
    },
    {
      conflict: 'docsDir (authored documentation input)',
      name: 'outDir nested below docsDir',
      options: { astro: { outDir: 'content/docs/generated' } },
      relationship: 'a descendant of'
    },
    {
      conflict: 'paths.frameworkRoot (Oxiquill framework input)',
      name: 'outDir containing frameworkRoot',
      options: { astro: { outDir: 'packages' }, paths: { frameworkRoot: 'packages/oxiquill' } },
      relationship: 'an ancestor of'
    },
    {
      conflict: 'paths.downloadCacheDir (persistent verified download cache)',
      name: 'outDir containing the persistent cache',
      options: { astro: { outDir: '.cache' } },
      relationship: 'an ancestor of'
    }
  ])('rejects $name', ({ conflict, options, relationship }) => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({ root, ...options })).toThrow(
      expect.objectContaining({
        message: expect.stringContaining(`${relationship} ${conflict}`)
      })
    );
  });

  it('rejects equal and nested cleanup roots with absolute diagnostics', () => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({ astro: { cacheDir: 'dist', outDir: 'dist' }, root })).toThrow(
      `cacheDir at ${path.join(root, 'dist')}: it is equal to outDir`
    );
    expect(() => resolveProject({ astro: { cacheDir: 'build', outDir: 'build/site' }, root })).toThrow(
      `cacheDir at ${path.join(root, 'build')}: it is an ancestor of outDir`
    );
  });

  it('rejects equality and nesting between generated subdirectory roles', () => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({ paths: { generatedDir: 'rust-cells' }, root })).toThrow(
      'paths.generatedDir at ' + path.join(root, '.oxiquill/rust-cells') + ': it is equal to paths.rustCellsDir'
    );
    expect(() =>
      resolveProject({ paths: { licensesPublicDir: 'runtime', rustWasmPublicDir: 'runtime/rust' }, root })
    ).toThrow('paths.licensesPublicDir at ' + path.join(root, 'public/oxiquill/runtime'));
  });

  it('keeps the intentional publicAssetsDir child relationship but rejects equality with publicDir', () => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({ root })).not.toThrow();
    expect(() => resolveProject({ paths: { publicAssetsDir: '.' }, root })).toThrow(
      `Unsafe path paths.publicAssetsDir at ${path.join(root, 'public')}`
    );
  });

  it('protects the selected Astro config from ancestor cleanup roots', () => {
    const root = path.resolve('/repo');
    const configFile = path.join(root, 'config/astro.custom.mjs');
    expect(() => resolveProject({ astro: { outDir: 'config' }, configFile, root })).toThrow(
      `outDir at ${path.join(root, 'config')}: it is an ancestor of configFile (selected Astro configuration) at ${configFile}`
    );
  });

  it('uses Astro config discovery order and explicit config paths', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'astro.config.ts'), 'export default {};\n');
    await writeFile(path.join(root, 'astro.config.js'), 'export default {};\n');

    expect(resolveAstroConfigFile({ cwd: root })).toBe(path.join(root, 'astro.config.js'));
    expect(resolveAstroConfigFile({ cwd: root, configFile: 'astro.config.ts' })).toBe(
      path.join(root, 'astro.config.ts')
    );
    expect(() => resolveAstroConfigFile({ cwd: root, configFile: 'missing.mjs' })).toThrow(
      'Astro config file was not found'
    );
  });

  it('loads a custom config through Vite and finds its integration metadata', async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, 'custom config.mts');
    await writeFile(
      configPath,
      [
        `import { defineOxiquillConfig } from ${JSON.stringify(astroModuleUrl)};`,
        'export default defineOxiquillConfig({',
        '  cacheDir: "custom cache",',
        '  framework: { starlight: () => ({ name: "starlight", hooks: {} }) },',
        '  paths: { docsDir: "written docs", generatedDir: "generated runtime" }',
        '});',
        ''
      ].join('\n')
    );

    const projectConfig = await loadOxiquillProjectConfig({ cwd: root, configFile: 'custom config.mts' });

    expect(projectConfig.paths).toMatchObject({
      cacheDir: path.join(root, 'custom cache'),
      docsDir: path.join(root, 'written docs'),
      generatedDir: path.join(root, 'custom cache/generated runtime')
    });
    expect(projectConfig.astroConfigArgs).toEqual(['--root', root, '--config', 'custom config.mts']);
  });

  it.each([undefined, '', 'caller-value', 'development', 'production'])(
    'restores NODE_ENV=%j after successful and failed discovery',
    async (nodeEnv) => {
      const original = process.env.NODE_ENV;
      const hadOriginal = Object.hasOwn(process.env, 'NODE_ENV');
      const root = await temporaryDirectory();
      try {
        for (const fails of [false, true]) {
          if (nodeEnv === undefined) delete process.env.NODE_ENV;
          else process.env.NODE_ENV = nodeEnv;
          const configFile = `environment-${fails}.mjs`;
          await writeFile(
            path.join(root, configFile),
            [
              `import { oxiquillIntegration } from ${JSON.stringify(astroModuleUrl)};`,
              'process.env.NODE_ENV = "config-mutation";',
              fails ? 'throw new Error("config failed");' : 'export default { integrations: [oxiquillIntegration()] };'
            ].join('\n')
          );
          const discovery = loadOxiquillProjectConfig({ cwd: root, configFile });
          if (fails) await expect(discovery).rejects.toThrow('Unable to load Oxiquill project config');
          else await discovery;
          expect(Object.hasOwn(process.env, 'NODE_ENV')).toBe(nodeEnv !== undefined);
          expect(process.env.NODE_ENV).toBe(nodeEnv);
        }
      } finally {
        if (hadOriginal) process.env.NODE_ENV = original;
        else delete process.env.NODE_ENV;
      }
    }
  );

  it('fails clearly for missing, invalid, absent, and duplicate integrations', async () => {
    const root = await temporaryDirectory();
    await expect(loadOxiquillProjectConfig({ cwd: root })).rejects.toThrow('No Astro config was found');

    await writeFile(path.join(root, 'invalid.mjs'), 'export default { broken: ;\n');
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'invalid.mjs' })).rejects.toThrow(
      'Unable to load Oxiquill project config'
    );

    await writeFile(path.join(root, 'none.mjs'), 'export default {};\n');
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'none.mjs' })).rejects.toThrow(
      'does not contain an Oxiquill integration'
    );

    await writeFile(
      path.join(root, 'duplicate.mjs'),
      [
        `import { oxiquillIntegration } from ${JSON.stringify(astroModuleUrl)};`,
        'export default { integrations: [oxiquillIntegration(), oxiquillIntegration()] };',
        ''
      ].join('\n')
    );
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'duplicate.mjs' })).rejects.toThrow(
      'contains 2 Oxiquill integrations; expected exactly one'
    );
  });
});

function resolveProject({ astro = {}, configFile, paths = {}, python = {}, root }) {
  return resolveOxiquillProjectConfig({
    astroConfig: { root, ...astro },
    astroExplicitFields: ['root', ...Object.keys(astro)],
    configFile,
    cwd: root,
    integrationMetadata: createOxiquillIntegrationMetadata({ paths, python })
  });
}

async function temporaryDirectory() {
  const directory = canonicalPath(await mkdtemp(path.join(tmpdir(), 'oxiquill-config-')));
  temporaryDirectories.push(directory);
  return directory;
}
