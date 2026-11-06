// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPackage } from '../../packages/oxiquill/scripts/build-package.mjs';
import { buildFingerprint, createOutputPlan, needsColdBuild } from '../../packages/oxiquill/scripts/build-plan.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('package build planning', () => {
  it('invalidates compiler/config changes and incomplete or unsupported manifests', () => {
    const input = { compilerVersion: '6.0.3', configs: { 'tsconfig.json': '{}', 'base.json': '{}' } };
    const fingerprint = buildFingerprint(input);
    const manifest = { schemaVersion: 1, fingerprint, files: ['index.js', 'index.d.ts'] };
    const state = { manifest, fingerprint, outputFiles: manifest.files };
    expect(needsColdBuild(state)).toBe(false);
    expect(buildFingerprint({ ...input, configs: { 'base.json': '{}', 'tsconfig.json': '{}' } })).toBe(fingerprint);
    for (const changed of [
      { ...input, compilerVersion: '6.0.4' },
      { ...input, configs: { ...input.configs, 'base.json': '{"compilerOptions":{}}' } }
    ]) {
      expect(needsColdBuild({ ...state, fingerprint: buildFingerprint(changed) })).toBe(true);
    }
    for (const previous of [undefined, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, files: [] }]) {
      expect(needsColdBuild({ ...state, manifest: previous })).toBe(true);
    }
    expect(needsColdBuild({ ...state, outputFiles: ['index.js'] })).toBe(true);
  });

  it('prunes outputs absent from the current compiler and asset sets', () => {
    expect(
      createOutputPlan({
        compiledFiles: ['index.js', 'index.d.ts'],
        assets: [{ target: 'style.css' }],
        outputFiles: ['stale.mjs', 'index.js', 'old-LICENSES.txt', 'style.css']
      })
    ).toEqual({ files: ['index.d.ts', 'index.js', 'style.css'], remove: ['stale.mjs', 'old-LICENSES.txt'] });
  });
});

describe('incremental package builds', () => {
  it('does not emit compiler output or rewrite assets on an unchanged build', async () => {
    const fixture = await createFixture();
    await fixture.build();
    const before = await snapshot(fixture.dist, true);
    await fixture.build();
    expect(await snapshot(fixture.dist, true)).toEqual(before);
    if (process.platform !== 'win32') {
      expect((await stat(path.join(fixture.dist, 'cli/index.mjs'))).mode & 0o111).toBe(0o111);
    }
    expect(await readFile(path.join(fixture.dist, 'cli/starter/v1/gitignore'), 'utf8')).toBe('node_modules/\n');
  }, 30000);

  it('matches clean output after adding, editing, renaming, and deleting sources and mirrored assets', async () => {
    const fixture = await createFixture();
    const paths = [
      'packages/oxiquill/src/extra.ts',
      'packages/oxiquill/src/module.mjs',
      'packages/oxiquill/src/view.tsx',
      'packages/oxiquill/src/components/Extra.astro',
      'packages/oxiquill/src/styles/extra.css',
      'packages/oxiquill/src/generator/license-data/python/v1-LICENSES.txt',
      'packages/oxiquill/src/generator/runtime-data/nested/extra.txt',
      'templates/basic/nested/extra.txt'
    ];
    await fixture.build();
    for (const file of paths) await fixture.write(file, sourceContent(file, 1));
    await expectCleanEquivalent(fixture);
    for (const file of paths) await fixture.write(file, sourceContent(file, 2));
    await expectCleanEquivalent(fixture);
    const renamed = paths.map((file) => file.replace(/\.(\w+)$/u, '-renamed.$1'));
    for (let index = 0; index < paths.length; index++) {
      await rename(path.join(fixture.root, paths[index]), path.join(fixture.root, renamed[index]));
    }
    await expectCleanEquivalent(fixture);
    for (const file of renamed) await rm(path.join(fixture.root, file));
    await fixture.write('packages/oxiquill/dist/accidental/old.txt', 'stale');
    await expectCleanEquivalent(fixture);
    expect(await readdir(fixture.dist)).not.toContain('accidental');
  }, 60000);

  it('recovers missing output, missing cache state, and malformed manifests', async () => {
    const fixture = await createFixture();
    await fixture.build();
    const expected = await snapshot(fixture.dist);
    for (const missing of [
      fixture.dist,
      path.join(fixture.dist, 'index.js'),
      path.join(fixture.dist, 'index.d.ts'),
      path.join(fixture.dist, 'styles/base.css'),
      fixture.manifest,
      fixture.buildInfo
    ]) {
      await rm(missing, { recursive: true, force: true });
      await fixture.build();
      expect(await snapshot(fixture.dist)).toEqual(expected);
    }
    await writeFile(fixture.manifest, '{invalid');
    await fixture.build();
    expect(await snapshot(fixture.dist)).toEqual(expected);
  }, 60000);

  it('does not retain a successful manifest after a type error and retries after correction', async () => {
    const fixture = await createFixture();
    await fixture.build();
    await fixture.write('packages/oxiquill/src/index.ts', 'export const value: number = "invalid";\n');
    await expect(fixture.build()).rejects.toThrow('TypeScript compilation failed');
    await expect(readFile(fixture.manifest)).rejects.toMatchObject({ code: 'ENOENT' });
    await fixture.write('packages/oxiquill/src/index.ts', 'export const value: number = 42;\n');
    await expectCleanEquivalent(fixture);
  }, 30000);

  it('rebuilds for direct and transitive config changes even when their effective options are identical', async () => {
    const fixture = await createFixture();
    await fixture.build();
    for (const file of ['packages/oxiquill/tsconfig.build.json', 'tsconfig.json', 'tsconfig.base.json']) {
      const before = await stat(path.join(fixture.dist, 'index.js'), { bigint: true });
      const config = path.join(fixture.root, file);
      await writeFile(config, `${await readFile(config, 'utf8')}\n`);
      await fixture.build();
      expect((await stat(path.join(fixture.dist, 'index.js'), { bigint: true })).mtimeNs).not.toBe(before.mtimeNs);
    }
  }, 30000);

  it('rebuilds when cached state was recorded with a different compiler fingerprint', async () => {
    const fixture = await createFixture();
    await fixture.build();
    const before = await stat(path.join(fixture.dist, 'index.js'), { bigint: true });
    const manifest = JSON.parse(await readFile(fixture.manifest, 'utf8'));
    await writeFile(fixture.manifest, JSON.stringify({ ...manifest, fingerprint: 'previous-compiler' }));
    await fixture.build();
    expect((await stat(path.join(fixture.dist, 'index.js'), { bigint: true })).mtimeNs).not.toBe(before.mtimeNs);
    expect(JSON.parse(await readFile(fixture.manifest, 'utf8')).fingerprint).toBe(manifest.fingerprint);
  }, 30000);

  it.skipIf(process.platform === 'win32')(
    'replaces output symlinks without modifying their targets',
    async () => {
      const fixture = await createFixture();
      await fixture.build();
      const external = path.join(fixture.root, 'keep.txt');
      await writeFile(external, 'keep');
      const output = path.join(fixture.dist, 'index.js');
      await rm(output);
      await symlink(external, output);
      await fixture.build();
      expect(await readFile(external, 'utf8')).toBe('keep');
      expect(await readFile(output, 'utf8')).toContain('export const value = 1');
    },
    30000
  );
});

function sourceContent(file, version) {
  return /\.(?:ts|tsx|mjs)$/u.test(file) ? `export const value = ${version};\n` : `asset version ${version}\n`;
}

async function expectCleanEquivalent(fixture) {
  await fixture.build();
  const incremental = await snapshot(fixture.dist);
  await rm(fixture.dist, { recursive: true });
  await fixture.build();
  expect(await snapshot(fixture.dist)).toEqual(incremental);
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-build-'));
  roots.push(root);
  const packageRoot = path.join(root, 'packages/oxiquill');
  const write = async (file, content) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  await write('tsconfig.base.json', JSON.stringify({ compilerOptions: { strict: true, types: [], target: 'es2022' } }));
  await write('tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
  await write(
    'packages/oxiquill/tsconfig.build.json',
    JSON.stringify({
      extends: '../../tsconfig.json',
      compilerOptions: {
        allowJs: true,
        declaration: true,
        incremental: true,
        tsBuildInfoFile: 'node_modules/.cache/oxiquill/package.tsbuildinfo',
        noEmitOnError: true,
        module: 'nodenext',
        jsx: 'preserve',
        outDir: 'dist',
        rootDir: 'src'
      },
      include: ['src/**/*.ts', 'src/**/*.tsx', 'src/**/*.mjs'],
      exclude: ['src/env.d.ts']
    })
  );
  for (const [file, content] of Object.entries({
    'packages/oxiquill/package.json': '{"type":"module"}',
    'packages/oxiquill/src/index.ts': 'export const value: number = 1;\n',
    'packages/oxiquill/src/cli/index.mjs': '#!/usr/bin/env node\nexport const cli = true;\n',
    'packages/oxiquill/src/env.d.ts': 'declare const environment: string;\n',
    'packages/oxiquill/src/styles/base.css': 'body {}\n',
    'packages/oxiquill/tsconfigs/strict.json': '{}',
    'templates/basic/.gitignore': 'node_modules/\n',
    'templates/basic/package.json': '{}'
  }))
    await write(file, content);
  return {
    root,
    dist: path.join(packageRoot, 'dist'),
    manifest: path.join(packageRoot, 'node_modules/.cache/oxiquill/package-output.json'),
    buildInfo: path.join(packageRoot, 'node_modules/.cache/oxiquill/package.tsbuildinfo'),
    write,
    build: () => buildPackage({ packageRoot })
  };
}

async function snapshot(directory, includeTimes = false, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) return snapshot(file, includeTimes, `${relative}/`);
      const info = await stat(file, { bigint: true });
      return [
        [relative, (await readFile(file)).toString('base64'), ...(includeTimes ? [info.mtimeNs, info.ctimeNs] : [])]
      ];
    })
  );
  return files.flat().sort(([a], [b]) => a.localeCompare(b));
}
