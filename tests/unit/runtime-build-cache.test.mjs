// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { validateProjectPathSafety } from '../../packages/oxiquill/src/config/path-safety.mjs';
import {
  createDirectoryStage,
  replaceDirectory
} from '../../packages/oxiquill/src/generator/doc-runtime/atomic-output.mjs';
import {
  artifactBuildFingerprint,
  getGeneratorIdentity,
  readGeneratorIdentity,
  readRustBuildInputs,
  rustBuildEnvironment
} from '../../packages/oxiquill/src/generator/doc-runtime/build-inputs.mjs';
import {
  haskellCacheDirectory,
  syncHaskellCacheSources,
  cargoEnvironment
} from '../../packages/oxiquill/src/generator/doc-runtime/compiler-cache.mjs';
import {
  recordedOutputIsComplete,
  recordOutputIntegrity
} from '../../packages/oxiquill/src/generator/doc-runtime/output-integrity.mjs';
import { buildHaskellWasm } from '../../packages/oxiquill/src/generator/doc-runtime/wasm-build.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-cache-unit-'));
  roots.push(root);
  return createOxiquillPaths({ workspaceRoot: root });
}
async function write(file, text = 'sentinel') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('runtime build inputs', () => {
  it('hashes generator files by content and relative name, independent of enumeration and install location', async () => {
    const paths = await fixture();
    for (const root of ['first', 'second']) {
      await Promise.all(
        [
          'generator/codegen.mjs',
          'generator/runtime-data/inputs.json',
          'config/paths.mjs',
          'lib/doc-runtime/authoring.js'
        ].map((file) => write(path.join(paths.workspaceRoot, root, file), file))
      );
    }
    const sourceRoot = path.join(paths.workspaceRoot, 'first');
    const first = await readGeneratorIdentity({ sourceRoot });
    expect(await readGeneratorIdentity({ sourceRoot: path.join(paths.workspaceRoot, 'second') })).toBe(first);
    for (const file of [
      'generator/codegen.mjs',
      'generator/runtime-data/inputs.json',
      'config/paths.mjs',
      'lib/doc-runtime/authoring.js'
    ]) {
      await write(path.join(sourceRoot, file), 'changed');
      expect(await readGeneratorIdentity({ sourceRoot })).not.toBe(first);
      await write(path.join(sourceRoot, file), file);
    }
    expect(getGeneratorIdentity()).toBe(getGeneratorIdentity());
    expect(await getGeneratorIdentity()).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS',
    'CARGO_PROFILE_RELEASE_LTO',
    'CARGO_BUILD_TARGET',
    'CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS',
    'CARGO_TARGET_DIR'
  ])('keys %s and ignores unrelated variables', async (name) => {
    const paths = await fixture();
    const original = await readRustBuildInputs({ environment: {}, paths });
    expect(await readRustBuildInputs({ environment: { [name]: 'changed' }, paths })).not.toBe(original);
    expect(await readRustBuildInputs({ environment: { UNRELATED: 'changed' }, paths })).toBe(original);
    expect(rustBuildEnvironment({ RUSTFLAGS: 'a', CARGO_BUILD_JOBS: '2' })).toEqual(
      rustBuildEnvironment({ CARGO_BUILD_JOBS: '2', RUSTFLAGS: 'a' })
    );
    expect(rustBuildEnvironment({ RUSTFLAGS: undefined })).toEqual({});
  });

  it('ignores parallelism settings that never change compiled output', async () => {
    const paths = await fixture();
    const original = await readRustBuildInputs({ environment: {}, paths });
    expect(await readRustBuildInputs({ environment: { CARGO_BUILD_JOBS: '4', BINARYEN_CORES: '2' }, paths })).toBe(
      original
    );
    expect(await readRustBuildInputs({ environment: { BINARYEN_PASS_DEBUG: '1' }, paths })).not.toBe(original);
  });

  it.each(['config', 'config.toml'])('keys Cargo %s presence, contents and removal', async (file) => {
    const paths = await fixture();
    const options = { environment: {}, paths };
    const first = await readRustBuildInputs(options);
    const config = path.join(paths.workspaceRoot, '.cargo', file);
    await write(config, '[build]\njobs = 2\n');
    const second = await readRustBuildInputs(options);
    expect(second).not.toBe(first);
    await write(config, '[build]\njobs = 3\n');
    expect(await readRustBuildInputs(options)).not.toBe(second);
    await rm(config);
    expect(await readRustBuildInputs(options)).toBe(first);
  });

  it('includes the artifact mode', () => {
    expect(artifactBuildFingerprint('same inputs', 'dev')).not.toBe(artifactBuildFingerprint('same inputs', 'build'));
  });
});

describe('persistent compiler caches', () => {
  it('preserves the Rust target outside a replaced source stage and respects user overrides', async () => {
    const paths = await fixture();
    const targetFile = path.join(paths.rustTargetDir, 'debug/dependency.rlib');
    await write(targetFile);
    await write(path.join(paths.rustCellsDir, 'old.rs'));
    const stage = await createDirectoryStage(paths.rustCellsDir);
    expect(cargoEnvironment({ environment: { NODE_PATH: 'excluded', PATH: 'keep' }, paths })).toEqual({
      PATH: 'keep',
      CARGO_TARGET_DIR: paths.rustTargetDir
    });
    await replaceDirectory(stage, paths.rustCellsDir);
    expect(await readFile(targetFile, 'utf8')).toBe('sentinel');
    expect(
      cargoEnvironment({ environment: { CARGO_TARGET_DIR: '../user-cache', NODE_PATH: 'excluded' }, paths })
    ).toEqual({ CARGO_TARGET_DIR: '../user-cache' });
  });

  it('keeps unchanged Haskell sources and drops stale sources, with separate mode/version directories', async () => {
    const paths = await fixture();
    const options = { paths, mode: 'dev', compilerVersion: '9.14.1' };
    const cache = haskellCacheDirectory(options);
    const targetDir = path.join(cache, 'src');
    await write(path.join(paths.haskellCellsDir, 'Main.hs'), 'main = pure ()');
    await write(path.join(paths.haskellCellsDir, 'Oxiquill/Output.hs'), 'module Oxiquill.Output where');
    await syncHaskellCacheSources({ sourceDir: paths.haskellCellsDir, targetDir });
    const helper = path.join(targetDir, 'Oxiquill/Output.hs');
    const before = await stat(helper);
    await write(path.join(paths.haskellCellsDir, 'Main.hs'), 'main = putStrLn "changed"');
    await write(path.join(targetDir, 'Obsolete.hs'));
    await syncHaskellCacheSources({ sourceDir: paths.haskellCellsDir, targetDir });
    expect((await stat(helper)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(path.join(targetDir, 'Main.hs'), 'utf8')).toContain('changed');
    expect(existsSync(path.join(targetDir, 'Obsolete.hs'))).toBe(false);
    expect(haskellCacheDirectory({ ...options, mode: 'build' })).not.toBe(cache);
    expect(haskellCacheDirectory({ ...options, compilerVersion: '9.14.2' })).not.toBe(cache);
    expect(() => haskellCacheDirectory({ ...options, compilerVersion: '../outside' })).toThrow(
      'Invalid Haskell compiler version'
    );
  });

  it('queries the compiler version for standalone builds and leaves persistent sources after failures', async () => {
    const paths = await fixture();
    await write(path.join(paths.haskellCellsDir, 'Main.hs'), 'main = pure ()');
    const runCommand = vi.fn(async (_command, args) => {
      if (args[0] === '--numeric-version') return '9.14.1\n';
      throw new Error('compile failed');
    });
    await expect(buildHaskellWasm({ environment: {}, paths, mode: 'dev', runCommand })).rejects.toThrow(
      'compile failed'
    );
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(paths.haskellBuildCacheDir, 'dev-9.14.1/src/Main.hs'))).toBe(true);
  });

  it('rejects overlap between generated sources and persistent compiler caches', async () => {
    const paths = await fixture();
    const overlap = createOxiquillPaths({
      workspaceRoot: paths.workspaceRoot,
      rustCellsDir: 'build-cache/rust-target/source'
    });
    expect(() => validateProjectPathSafety({ paths: overlap })).toThrow(/compiler cache|buildCacheDir/u);
  });
});

describe('runtime output integrity', () => {
  it('checks binary contents, file size and missing files before reuse', async () => {
    const paths = await fixture();
    const directory = paths.rustWasmPublicDir;
    const file = path.join(directory, 'nested/runtime.wasm');
    await write(file, Buffer.from([0, 1, 255]));
    const publicFileIntegrity = await recordOutputIntegrity(directory);
    const state = { publicFiles: Object.keys(publicFileIntegrity), publicFileIntegrity };
    expect(publicFileIntegrity['nested/runtime.wasm'].size).toBe(3);
    expect(await recordedOutputIsComplete(state, directory)).toBe(true);
    await write(file, Buffer.from([0, 2, 255]));
    expect(await recordedOutputIsComplete(state, directory)).toBe(false);
    await write(file, Buffer.from([0]));
    expect(await recordedOutputIsComplete(state, directory)).toBe(false);
    await rm(file);
    expect(await recordedOutputIsComplete(state, directory)).toBe(false);
    await mkdir(file);
    expect(await recordedOutputIsComplete(state, directory)).toBe(false);
  });

  it.each([
    undefined,
    {},
    { publicFiles: [] },
    { publicFiles: ['old.js'] },
    { publicFiles: ['../outside'] },
    { publicFiles: ['/absolute'] },
    { publicFiles: [''] },
    { publicFiles: [null] },
    { publicFiles: ['file'], publicFileIntegrity: { file: { size: -1, sha256: 'invalid' } } },
    { publicFiles: ['file'], publicFileIntegrity: { file: { size: 1, sha256: 'invalid' } } }
  ])('treats missing or malformed state as incomplete: %j', async (state) => {
    expect(await recordedOutputIsComplete(state, '/unused')).toBe(false);
  });
});
