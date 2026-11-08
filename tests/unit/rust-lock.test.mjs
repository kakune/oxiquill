// @vitest-environment node
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';
import { hashBytes } from '../../packages/oxiquill/src/generator/doc-runtime/hashing.mjs';
import { createHelperClosureReader } from '../../packages/oxiquill/src/generator/doc-runtime/rust-helper-closure.mjs';
import {
  compareSemver,
  groupLockClosure,
  lockClosure,
  parseLockReference,
  resolveWorkspaceLock,
  runtimeLockClosure,
  seedWorkspaceLock,
  semverCompatibility
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-lock.mjs';

const { parse } = createRequire(path.resolve('packages/oxiquill/package.json'))('smol-toml');
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const runtimeLock = await readFile('packages/oxiquill/src/generator/license-data/rust/runtime-Cargo.lock', 'utf8');
const runtimeData = JSON.parse(
  await readFile('packages/oxiquill/src/generator/runtime-data/runtime-inputs.json', 'utf8')
);
const runtimeInputs = { rustLock: runtimeLock, rust: runtimeData.rust };
const entry = (name, version, dependencies) => ({
  name,
  version,
  source: registry,
  checksum: hashBytes(`${name}@${version}`),
  ...(dependencies ? { dependencies } : {})
});

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// A helper workspace like the one in #217: its lock carries a semver-compatible
// alternative of runtime-pinned serde and syn, plus dev-only packages.
async function helperWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-lock-'));
  roots.push(root);
  const put = async (file, text) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  };
  await put('crates/Cargo.toml', '[workspace]\nmembers = ["helper", "tests"]\nresolver = "3"\n');
  await put(
    'crates/helper/Cargo.toml',
    [
      '[package]',
      'name = "helper"',
      'version = "1.4.0"',
      'edition = "2024"',
      '[dependencies]',
      'serde = { version = "1.0.220", features = ["derive"] }',
      'json = { package = "serde_json", version = "1" }',
      '[dev-dependencies]',
      'num = "0.4"',
      'workspace-tests = { path = "../tests" }',
      "[target.'cfg(unix)'.dev-dependencies]",
      'itoa = "1"',
      ''
    ].join('\n')
  );
  await put('crates/helper/src/lib.rs', 'pub fn value() -> u8 { 1 }\n');
  await put('crates/tests/Cargo.toml', '[package]\nname = "workspace-tests"\nversion = "1.4.0"\n');
  await put('crates/tests/src/lib.rs', '');
  const packages = [
    { name: 'helper', version: '1.4.0', dependencies: ['num', 'serde 1.0.228', 'serde_json', 'workspace-tests'] },
    { name: 'workspace-tests', version: '1.4.0', dependencies: ['num'] },
    entry('num', '0.4.3', ['num-traits']),
    entry('num-traits', '0.2.19', ['autocfg']),
    entry('autocfg', '1.5.0'),
    entry('serde', '1.0.228', ['serde_derive']),
    entry('serde', '0.9.15'),
    entry('serde_derive', '1.0.228', ['syn']),
    entry('serde_json', '1.0.149', ['itoa', 'serde 1.0.228']),
    entry('itoa', '1.0.17'),
    entry('syn', '3.0.9')
  ];
  const lockText = (list) =>
    `version = 4\n${list
      .map(
        (pkg) =>
          `\n[[package]]\nname = "${pkg.name}"\nversion = "${pkg.version}"${pkg.source ? `\nsource = "${pkg.source}"\nchecksum = "${pkg.checksum}"` : ''}${pkg.dependencies ? `\ndependencies = ${JSON.stringify(pkg.dependencies)}` : ''}\n`
      )
      .join('')}`;
  await put('crates/Cargo.lock', lockText(packages));
  const paths = createOxiquillPaths({ workspaceRoot: root });
  const reader = (fileSystem = defaultFileSystem) =>
    createHelperClosureReader({
      paths,
      helperCrates: new Map([['helper', { name: 'helper', relativePath: '../../crates/helper' }]]),
      fileSystem,
      digest: async (file) => hashBytes(await fileSystem.readFile(file))
    });
  return { root, paths, put, reader, packages, lockText };
}

describe('Cargo.lock references and versions', () => {
  it('parses every reference form and semver compatibility class', () => {
    expect(parseLockReference('serde')).toEqual({ name: 'serde' });
    expect(parseLockReference('serde 1.0.228')).toEqual({ name: 'serde', version: '1.0.228' });
    expect(parseLockReference(`serde 1.0.228 (${registry})`)).toEqual({
      name: 'serde',
      version: '1.0.228',
      source: registry
    });
    expect(() => parseLockReference('')).toThrow('Invalid Cargo.lock dependency reference');
    expect(['1.2.3', '0.7.1', '0.0.3', '2.0.0-rc.1'].map(semverCompatibility)).toEqual(['1', '0.7', '0.0.3', '2']);
    expect(compareSemver('1.0.229', '1.0.228')).toBe(1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0+build', '1.0.0')).toBe(0);
  });

  it('seeds only runtime packages reachable from the generated crates', () => {
    const names = runtimeLockClosure(runtimeInputs).map((pkg) => pkg.name);
    expect(names).toEqual(expect.arrayContaining(Object.keys(runtimeData.rust.dependencies)));
    expect(names).not.toEqual(expect.arrayContaining(['doc-rust-cells']));
    for (const local of ['doc-rust-cells', 'doc-rust', 'doc-rust-text']) expect(names).not.toContain(local);
    expect(runtimeLockClosure(runtimeInputs).every((pkg) => pkg.source === registry)).toBe(true);
  });
});

describe('helper dependency closure', () => {
  it('follows normal and build dependencies but never dev-dependencies', async () => {
    const workspace = await helperWorkspace();
    const closure = await workspace.reader().closure(['helper']);
    expect(closure.packages.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'itoa@1.0.17',
      'serde@1.0.228',
      'serde_derive@1.0.228',
      'serde_json@1.0.149',
      'syn@3.0.9'
    ]);
    expect(closure.inputs.map((input) => input.path)).toEqual([
      'crates/Cargo.lock#helper',
      'crates/Cargo.toml#helper',
      'crates/helper/Cargo.toml',
      'crates/helper/src/lib.rs'
    ]);
  });

  it('reads each helper once per run and ignores dev-only manifest and lock edits', async () => {
    const workspace = await helperWorkspace();
    const reads = vi.fn(defaultFileSystem.readFile);
    const reader = workspace.reader({ ...defaultFileSystem, readFile: reads });
    const first = await reader.closure(['helper']);
    const count = reads.mock.calls.length;
    expect(await reader.closure(['helper', 'helper'])).toEqual(first);
    expect(reads).toHaveBeenCalledTimes(count);
    const manifest = await readFile(path.join(workspace.root, 'crates/helper/Cargo.toml'), 'utf8');
    await workspace.put(
      'crates/helper/Cargo.toml',
      manifest.replace('num = "0.4"', 'num = "0.4.3"\ncriterion = "0.5"')
    );
    await workspace.put(
      'crates/Cargo.lock',
      workspace.lockText(workspace.packages.map((pkg) => (pkg.name === 'num' ? entry('num', '0.4.4') : pkg)))
    );
    expect(await workspace.reader().closure(['helper'])).toEqual(first);
    await workspace.put('crates/helper/Cargo.toml', manifest.replace('version = "1.0.220"', 'version = "1.0.221"'));
    expect((await workspace.reader().closure(['helper'])).inputs).not.toEqual(first.inputs);
  });

  it('names unknown crates and cyclic path dependencies', async () => {
    const workspace = await helperWorkspace();
    await expect(workspace.reader().closure(['missing'])).rejects.toThrow('Unknown Rust helper crate missing');
    await workspace.put(
      'crates/tests/Cargo.toml',
      '[package]\nname = "workspace-tests"\nversion = "1.4.0"\n[dependencies]\nhelper = { path = "../helper" }\n'
    );
    const manifest = await readFile(path.join(workspace.root, 'crates/helper/Cargo.toml'), 'utf8');
    await workspace.put(
      'crates/helper/Cargo.toml',
      manifest
        .replace('[dev-dependencies]', 'workspace-tests = { path = "../tests" }\n[dev-dependencies]')
        .replace('workspace-tests = { path = "../tests" }\n[target', '[target')
    );
    await expect(workspace.reader().closure(['helper'])).rejects.toThrow('path dependencies form a cycle');
  });
});

describe('workspace lock seed', () => {
  it('keeps runtime pins, rewrites references, and leaves path packages to Cargo', async () => {
    const workspace = await helperWorkspace();
    const helper = await workspace.reader().closure(['helper']);
    const seed = parse(seedWorkspaceLock({ runtime: runtimeLockClosure(runtimeInputs), helpers: helper.packages }));
    const versions = (name) => seed.package.filter((pkg) => pkg.name === name).map((pkg) => pkg.version);
    expect(versions('serde')).toEqual([runtimeData.rust.dependencies.serde]);
    expect(versions('serde_json')).toEqual([runtimeData.rust.dependencies.serde_json]);
    expect(versions('syn')).toEqual(['3.0.7']);
    expect(versions('itoa')).toEqual(['1.0.18']);
    expect(seed.package.every((pkg) => pkg.source === registry)).toBe(true);
    for (const name of ['num', 'autocfg', 'helper', 'workspace-tests']) expect(versions(name)).toEqual([]);
    const names = new Set(seed.package.map((pkg) => pkg.name));
    for (const reference of seed.package.flatMap((pkg) => pkg.dependencies ?? []))
      expect(names.has(parseLockReference(reference).name)).toBe(true);
  });

  it('keeps semver-incompatible versions apart and prefers helper locks over previous resolutions', () => {
    const seed = parse(
      seedWorkspaceLock({
        helpers: [
          entry('rand', '0.7.3'),
          entry('rand', '0.8.5', ['rand 0.7.3']),
          entry('rand', '0.8.4'),
          entry('tiny', '0.0.3'),
          entry('tiny', '0.0.4'),
          entry('either', '1.15.0')
        ],
        previous: [entry('either', '1.16.0'), entry('stable', '2.1.0'), { name: 'local', version: '1.0.0' }]
      })
    );
    expect(seed.package.map((pkg) => `${pkg.name}@${pkg.version}`)).toEqual([
      'either@1.15.0',
      'rand@0.7.3',
      'rand@0.8.5',
      'stable@2.1.0',
      'tiny@0.0.3',
      'tiny@0.0.4'
    ]);
    expect(seed.package.find((pkg) => pkg.version === '0.8.5').dependencies).toEqual(['rand 0.7.3']);
    expect(seedWorkspaceLock({ helpers: [entry('rand', '0.8.5')] })).toBe(
      seedWorkspaceLock({ helpers: [entry('rand', '0.8.5')], previous: [] })
    );
  });

  it('computes each module closure from the resolved lock', () => {
    const lock = {
      version: 4,
      package: [
        { name: 'doc-rust-page-1', version: '0.4.1', dependencies: ['helper', 'serde'] },
        { name: 'doc-rust-page-2', version: '0.4.1', dependencies: ['serde'] },
        { name: 'helper', version: '1.0.0', dependencies: ['itoa'] },
        entry('serde', '1.0.229'),
        entry('itoa', '1.0.18')
      ]
    };
    expect(groupLockClosure(lock, 'doc-rust-page-2')).toEqual([
      ['serde', '1.0.229', registry, hashBytes('serde@1.0.229')]
    ]);
    expect(groupLockClosure(lock, 'doc-rust-page-1').map(([name]) => name)).toEqual(['helper', 'itoa', 'serde']);
    expect(groupLockClosure(lock, 'missing')).toBeUndefined();
    expect(lockClosure(lock.package, ['helper'], { include: (pkg) => pkg.source }).map((pkg) => pkg.name)).toEqual([]);
  });
});

describe('workspace lock resolution', () => {
  it('lets Cargo finish the seeded lock without --locked and explains failures', async () => {
    const paths = createOxiquillPaths({ workspaceRoot: path.resolve('/book') });
    const runCommand = vi.fn(async (command, args, options) => {
      options.onStdoutLine('{"packages":[]}');
    });
    await resolveWorkspaceLock({ paths, environment: { CARGO_NET_OFFLINE: 'true' }, runCommand });
    expect(runCommand).toHaveBeenCalledWith(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--manifest-path',
        path.join(paths.rustCellsDir, 'Cargo.toml'),
        '--filter-platform',
        'wasm32-unknown-unknown'
      ],
      expect.objectContaining({ env: { CARGO_NET_OFFLINE: 'true' }, phase: 'generation', source: 'cargo' })
    );
    expect(runCommand.mock.calls[0][1]).not.toContain('--locked');
    const failure = Object.assign(new Error('failed to select a version for `serde`'), { exitCode: 101 });
    await expect(
      resolveWorkspaceLock({ paths, environment: {}, runCommand: vi.fn().mockRejectedValue(failure) })
    ).rejects.toMatchObject({ exitCode: 101, message: expect.stringContaining('exact versions Oxiquill pins') });
  });
});
