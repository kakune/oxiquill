// @vitest-environment node

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOxiquillIntegrationMetadata
} from '../../packages/oxiquill/src/config/metadata.mjs';
import {
  loadOxiquillProjectConfig,
  resolveAstroConfigFile,
  resolveOxiquillProjectConfig
} from '../../packages/oxiquill/src/config/project-config.mjs';
import { normalizePath } from '../../packages/oxiquill/src/config/paths.mjs';

const temporaryDirectories = [];
const astroModuleUrl = new URL('../../packages/oxiquill/src/astro/index.ts', import.meta.url).href;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
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
        generatedDir: path.join(root, '.oxiquill/generated'),
        outDir: path.join(root, 'dist'),
        publicDir: path.join(root, 'public'),
        publicAssetsDir: path.join(root, 'public/oxiquill')
      }
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
        generatedDir: 'runtime generated',
        licensesPublicDir: 'legal notices',
        publicAssetsDir: 'runtime assets',
        rustWasmPublicDir: 'rust output'
      }
    });

    expect(projectConfig.paths).toMatchObject({
      cratesDir: absoluteCrates,
      docsDir: path.join(root, 'written docs'),
      generatedDir: path.join(root, 'state cache/runtime generated'),
      licensesPublicDir: path.join(root, 'site public/runtime assets/legal notices'),
      publicAssetsDir: path.join(root, 'site public/runtime assets'),
      rustWasmPublicDir: path.join(root, 'site public/runtime assets/rust output')
    });
  });

  it('normalizes Windows separators for generated URLs and identifiers', () => {
    expect(normalizePath('C:\\workspace\\public\\oxiquill assets')).toBe(
      'C:/workspace/public/oxiquill assets'
    );
  });

  it('accepts equivalent explicit paths and reports conflicting fields', () => {
    const root = path.resolve('/repo');
    expect(() => resolveProject({
      root,
      astro: { publicDir: './public-assets' },
      paths: { publicDir: 'nested/../public-assets' }
    })).not.toThrow();

    expect(() => resolveProject({
      root,
      astro: { cacheDir: '.astro-cache' },
      paths: { cacheDir: '.runtime-cache' }
    })).toThrow(
      `Conflicting project paths: cacheDir resolves to ${path.join(root, '.astro-cache')}, ` +
        `but paths.cacheDir resolves to ${path.join(root, '.runtime-cache')}.`
    );
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
    expect(() => resolveProject({ root, paths: { docsDir: new URL('https://example.com/docs') } }))
      .toThrow('docsDir must be a path string or file URL');
    expect(() => resolveProject({ root, astro: { cacheDir: '.' } }))
      .toThrow('cacheDir must resolve to a directory inside');
    expect(() => resolveProject({ root, paths: { publicAssetsDir: '..' } }))
      .toThrow('paths.publicAssetsDir must resolve to a directory inside');
  });

  it('uses Astro config discovery order and explicit config paths', async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, 'astro.config.ts'), 'export default {};\n');
    await writeFile(path.join(root, 'astro.config.js'), 'export default {};\n');

    expect(resolveAstroConfigFile({ cwd: root })).toBe(path.join(root, 'astro.config.js'));
    expect(resolveAstroConfigFile({ cwd: root, configFile: 'astro.config.ts' }))
      .toBe(path.join(root, 'astro.config.ts'));
    expect(() => resolveAstroConfigFile({ cwd: root, configFile: 'missing.mjs' }))
      .toThrow('Astro config file was not found');
  });

  it('loads a custom config through Vite and finds its integration metadata', async () => {
    const root = await temporaryDirectory();
    const configPath = path.join(root, 'custom config.mts');
    await writeFile(configPath, [
      `import { defineOxiquillConfig } from ${JSON.stringify(astroModuleUrl)};`,
      'export default defineOxiquillConfig({',
      '  cacheDir: "custom cache",',
      '  paths: { docsDir: "written docs", generatedDir: "generated runtime" }',
      '});',
      ''
    ].join('\n'));

    const projectConfig = await loadOxiquillProjectConfig({ cwd: root, configFile: 'custom config.mts' });

    expect(projectConfig.paths).toMatchObject({
      cacheDir: path.join(root, 'custom cache'),
      docsDir: path.join(root, 'written docs'),
      generatedDir: path.join(root, 'custom cache/generated runtime')
    });
    expect(projectConfig.astroConfigArgs).toEqual([
      '--root', root, '--config', 'custom config.mts'
    ]);
  });

  it('fails clearly for missing, invalid, absent, and duplicate integrations', async () => {
    const root = await temporaryDirectory();
    await expect(loadOxiquillProjectConfig({ cwd: root })).rejects.toThrow('No Astro config was found');

    await writeFile(path.join(root, 'invalid.mjs'), 'export default { broken: ;\n');
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'invalid.mjs' }))
      .rejects.toThrow('Unable to load Oxiquill project config');

    await writeFile(path.join(root, 'none.mjs'), 'export default {};\n');
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'none.mjs' }))
      .rejects.toThrow('does not contain an Oxiquill integration');

    await writeFile(path.join(root, 'duplicate.mjs'), [
      `import { oxiquillIntegration } from ${JSON.stringify(astroModuleUrl)};`,
      'export default { integrations: [oxiquillIntegration(), oxiquillIntegration()] };',
      ''
    ].join('\n'));
    await expect(loadOxiquillProjectConfig({ cwd: root, configFile: 'duplicate.mjs' }))
      .rejects.toThrow('contains 2 Oxiquill integrations; expected exactly one');
  });
});

function resolveProject({ astro = {}, paths = {}, root }) {
  return resolveOxiquillProjectConfig({
    astroConfig: { root, ...astro },
    astroExplicitFields: ['root', ...Object.keys(astro)],
    cwd: root,
    integrationMetadata: createOxiquillIntegrationMetadata({ paths })
  });
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'oxiquill-config-'));
  temporaryDirectories.push(directory);
  return directory;
}
