// @vitest-environment node

import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';

const cliMocks = vi.hoisted(() => ({
  buildHaskellWasm: vi.fn(),
  buildRustWasm: vi.fn(),
  cleanOxiquillWorkspace: vi.fn(),
  createDocRuntimeContext: vi.fn(),
  loadProjectConfig: vi.fn(),
  markRuntimeReady: vi.fn(),
  runHelperCargo: vi.fn(),
  syncDocRuntime: vi.fn(),
  syncLicenseArtifacts: vi.fn()
}));

vi.mock('../../packages/oxiquill/src/generator/doc-runtime-service.mjs', () => ({
  buildHaskellWasm: cliMocks.buildHaskellWasm,
  buildRustWasm: cliMocks.buildRustWasm,
  createDocRuntimeContext: cliMocks.createDocRuntimeContext,
  markRuntimeReady: cliMocks.markRuntimeReady,
  syncDocRuntime: cliMocks.syncDocRuntime,
  syncLicenseArtifacts: cliMocks.syncLicenseArtifacts
}));
vi.mock('../../packages/oxiquill/src/generator/clean.mjs', () => ({
  cleanOxiquillWorkspace: cliMocks.cleanOxiquillWorkspace
}));
vi.mock('../../packages/oxiquill/src/generator/run-helper-cargo.mjs', () => ({
  runHelperCargo: cliMocks.runHelperCargo
}));
vi.mock('../../packages/oxiquill/src/config/project-config.mjs', () => ({
  loadOxiquillProjectConfig: cliMocks.loadProjectConfig
}));

const cliPath = fileURLToPath(new URL('../../packages/oxiquill/src/cli/index.mjs', import.meta.url));
const actualRepoRoot = fileURLToPath(new URL('../..', import.meta.url));
const actualPaths = createOxiquillPaths({ workspaceRoot: actualRepoRoot });
const actualProjectConfig = Object.freeze({
  astroConfigArgs: Object.freeze([]),
  cwd: actualRepoRoot,
  paths: actualPaths
});
const repoRoot = path.resolve('/repo');
const { canLoadNativePackage, frameworkEnv, isCliEntrypoint, nodeExecutableCandidates, runCli, selectFrameworkNode } =
  await import('../../packages/oxiquill/src/cli/commands.mjs');
const { parseConfigOption } = await import('../../packages/oxiquill/src/cli/config-option.mjs');
const testRoot = path.parse(process.cwd()).root;

beforeEach(() => {
  vi.clearAllMocks();
  const paths = createOxiquillPaths({ workspaceRoot: repoRoot });
  cliMocks.createDocRuntimeContext.mockResolvedValue({ paths });
  cliMocks.loadProjectConfig.mockResolvedValue({ astroConfigArgs: [], cwd: repoRoot, paths });
  cliMocks.syncDocRuntime.mockResolvedValue({
    cellCount: 1,
    haskellCellCount: 1,
    haskellFingerprint: 'haskell-fingerprint'
  });
  cliMocks.buildHaskellWasm.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('oxiquill CLI', () => {
  it('parses one config option without forwarding it to command-specific arguments', () => {
    expect(parseConfigOption(['--host', 'localhost', '--config', 'custom config.mts'])).toEqual({
      commandArgs: ['--host', 'localhost'],
      configFile: 'custom config.mts'
    });
    expect(parseConfigOption(['--config=custom.mjs'])).toEqual({
      commandArgs: [],
      configFile: 'custom.mjs'
    });
    expect(() => parseConfigOption(['--config'])).toThrow('--config must be followed by a path');
    expect(() => parseConfigOption(['--config=a', '--config', 'b'])).toThrow(
      '--config may only be specified once'
    );
  });

  it('loads a selected config once and forwards the resolved Astro arguments', async () => {
    const loadProjectConfig = vi.fn(async () => ({
      ...actualProjectConfig,
      astroConfigArgs: ['--root', actualRepoRoot, '--config', '../custom config.mts']
    }));
    const runCommand = vi.fn(async () => undefined);
    const nodePath = fakeNodeExecutable(path.join(testRoot, 'node', 'bin'));

    await runCli('preview', ['--host', 'localhost', '--config', 'custom config.mts'], {
      cwd: '/invocation',
      loadProjectConfig,
      runCommand,
      selectNode: () => nodePath
    });

    expect(loadProjectConfig).toHaveBeenCalledOnce();
    expect(loadProjectConfig).toHaveBeenCalledWith({ cwd: '/invocation', configFile: 'custom config.mts' });
    expect(runCommand).toHaveBeenCalledWith(
      nodePath,
      expect.arrayContaining([
        'preview', '--root', actualRepoRoot, '--config', '../custom config.mts', '--host', 'localhost'
      ]),
      expect.objectContaining({ cwd: actualRepoRoot })
    );
  });

  it('can be imported without running the command dispatcher', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cli = await import('../../packages/oxiquill/src/cli/index.mjs');

    await runCli('help', [], { cwd: repoRoot, runCommand: vi.fn() });

    expect(cli.runCli).toBe(runCli);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: oxiquill'));
  });

  it('rejects unknown commands', async () => {
    await expect(runCli('unknown', [], { cwd: repoRoot, runCommand: vi.fn() })).rejects.toThrow(
      'Unknown oxiquill command "unknown".'
    );
  });

  it('recognizes pnpm-style bin symlinks as the CLI entrypoint', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'oxiquill-cli-'));
    const symlinkPath = path.join(directory, 'oxiquill');

    try {
      await symlink(cliPath, symlinkPath, 'file');

      expect(isCliEntrypoint(symlinkPath, pathToFileURL(cliPath).href)).toBe(true);
      expect(isCliEntrypoint('/not/the/cli', pathToFileURL(cliPath).href)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('deduplicates node executable candidates from PATH', () => {
    const badDirectory = path.join(testRoot, 'bad', 'bin');
    const goodDirectory = path.join(testRoot, 'good', 'bin');
    const badNode = fakeNodeExecutable(badDirectory);
    const goodNode = fakeNodeExecutable(goodDirectory);
    const exists = (candidate) => [badNode, goodNode].includes(candidate);

    expect(
      nodeExecutableCandidates({
        execPath: badNode,
        exists,
        pathValue: [badDirectory, goodDirectory].join(path.delimiter)
      })
    ).toEqual([badNode, goodNode]);
  });

  it('checks whether a node executable can load a native package', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const packagePath = path.join(repoRoot, 'node_modules', 'rollup');

    expect(canLoadNativePackage('/usr/bin/node', packagePath, { cwd: repoRoot, env: {}, spawn })).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['-e', expect.stringContaining('import(process.argv[1])'), pathToFileURL(packagePath).href],
      {
        cwd: repoRoot,
        env: {},
        stdio: 'ignore'
      }
    );
  });

  it('preserves case-insensitive PATH keys in the framework environment', () => {
    const nodePath = fakeNodeExecutable(path.join(testRoot, 'node', 'bin'));
    const toolPath = path.join(testRoot, 'tools', 'bin');
    const env = frameworkEnv(actualPaths, { env: { Path: toolPath }, nodePath });

    expect(env.Path).toBe(`${path.dirname(nodePath)}${path.delimiter}${toolPath}`);
    expect(env.PATH).toBeUndefined();
  });

  it('uses a later PATH node for Astro when the current node cannot load native addons', () => {
    const badDirectory = path.join(testRoot, 'bad', 'bin');
    const goodDirectory = path.join(testRoot, 'good', 'bin');
    const badNode = fakeNodeExecutable(badDirectory);
    const goodNode = fakeNodeExecutable(goodDirectory);
    const spawn = vi.fn((nodePath) => ({ status: nodePath === goodNode ? 0 : 1 }));
    const warn = vi.fn();
    const exists = (candidate) => [badNode, goodNode].includes(candidate);

    expect(
      selectFrameworkNode(actualPaths, {
        env: {
          PATH: [badDirectory, goodDirectory].join(path.delimiter)
        },
        execPath: badNode,
        exists,
        spawn,
        warn
      })
    ).toBe(goodNode);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Using ${goodNode} for Astro/Vite`));
  });

  it('selects the framework node separately for each CLI invocation', async () => {
    const firstNode = fakeNodeExecutable(path.join(testRoot, 'first', 'bin'));
    const secondNode = fakeNodeExecutable(path.join(testRoot, 'second', 'bin'));
    const commands = [];
    const selectNode = vi.fn().mockReturnValueOnce(firstNode).mockReturnValueOnce(secondNode);
    const runCommand = async (command) => {
      commands.push(command);
    };

    const loadProjectConfig = async () => actualProjectConfig;
    await runCli('preview', [], {
      cwd: actualRepoRoot,
      loadProjectConfig,
      runCommand,
      selectNode
    });
    await runCli('preview', [], {
      cwd: actualRepoRoot,
      loadProjectConfig,
      runCommand,
      selectNode
    });

    expect(selectNode).toHaveBeenCalledTimes(2);
    expect(commands).toEqual([firstNode, secondNode]);
  });

  it('dispatches helper crate commands with strict coverage and lint arguments', async () => {
    await runCli('test-rust', [], { cwd: repoRoot });
    await runCli('test-rust-coverage', [], { cwd: repoRoot });
    await runCli('lint-rust', [], { cwd: repoRoot });
    await runCli('doc-rust', [], { cwd: repoRoot });

    expect(cliMocks.runHelperCargo).toHaveBeenNthCalledWith(1, expect.objectContaining({ argv: ['test'] }));
    expect(cliMocks.runHelperCargo).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        argv: expect.arrayContaining([
          'llvm-cov',
          '--fail-under-lines',
          '85',
          '--fail-under-functions',
          '--fail-under-regions'
        ])
      })
    );
    expect(cliMocks.runHelperCargo).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ argv: ['clippy', '--all-targets', '--', '-D', 'warnings'] })
    );
    expect(cliMocks.runHelperCargo).toHaveBeenNthCalledWith(4, expect.objectContaining({ argv: ['doc', '--no-deps'] }));
  });

  it('cleans generated workspace output through the owned cleaner', async () => {
    await runCli('clean', [], { cwd: repoRoot });

    expect(cliMocks.cleanOxiquillWorkspace).toHaveBeenCalledWith({
      paths: expect.objectContaining({ workspaceRoot: expect.any(URL) })
    });
  });

  it('generates manifests without Wasm unless a valid mode is requested', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli('docgen', [], { cwd: repoRoot });
    expect(cliMocks.syncDocRuntime).toHaveBeenCalledTimes(1);
    expect(cliMocks.buildRustWasm).not.toHaveBeenCalled();
    expect(cliMocks.markRuntimeReady).toHaveBeenCalledTimes(1);

    await runCli('docgen', ['--wasm', 'dev'], { cwd: repoRoot });
    expect(cliMocks.buildRustWasm).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dev' }));
    expect(cliMocks.buildHaskellWasm).toHaveBeenCalledWith(
      expect.objectContaining({ haskellFingerprint: 'haskell-fingerprint', mode: 'dev' })
    );
    expect(cliMocks.syncLicenseArtifacts).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Generated 1 interactive cell(s).');
  });

  it('rejects invalid Wasm generation modes before creating a runtime', async () => {
    await expect(runCli('docgen', ['--wasm', 'release'], { cwd: repoRoot })).rejects.toThrow(
      '--wasm must be followed by "dev" or "build".'
    );
    expect(cliMocks.createDocRuntimeContext).not.toHaveBeenCalled();
  });

  it('runs generated Rust cells through wasm-pack', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const runCommand = vi.fn(async () => undefined);

    await runCli('test-wasm', [], { cwd: repoRoot, runCommand });

    expect(runCommand).toHaveBeenCalledWith(
      'wasm-pack',
      ['test', '--node', path.join(repoRoot, '.oxiquill', 'rust-cells')],
      { cwd: repoRoot }
    );
    expect(cliMocks.buildRustWasm).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dev' }));
    expect(log).toHaveBeenCalled();
  });

  it('reports missing CLI entrypoints and unusable Node overrides', () => {
    expect(isCliEntrypoint(undefined, pathToFileURL(cliPath).href)).toBe(false);
    expect(canLoadNativePackage('/bad/node', '/bad/package', { spawn: vi.fn(() => ({ status: 1 })) })).toBe(false);

    expect(() =>
      selectFrameworkNode(actualPaths, {
        env: { OXIQUILL_NODE: '/bad/node', PATH: '' },
        execPath: '/bad/node',
        exists: () => true,
        spawn: vi.fn(() => ({ status: 1 })),
        warn: vi.fn()
      })
    ).toThrow('OXIQUILL_NODE is set to /bad/node');
  });
});

function fakeNodeExecutable(directory) {
  return path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
}
