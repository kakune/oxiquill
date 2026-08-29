// @vitest-environment node

import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';

const cliPath = fileURLToPath(new URL('../../packages/oxiquill/src/cli/index.mjs', import.meta.url));
const actualRepoRoot = fileURLToPath(new URL('../..', import.meta.url));
const actualPaths = createOxiquillPaths({ workspaceRoot: actualRepoRoot });
const actualProjectConfig = Object.freeze({
  astroConfigArgs: Object.freeze([]),
  cwd: actualRepoRoot,
  paths: actualPaths
});
const repoRoot = path.resolve('/repo');
const { canLoadNativePackage, isCliEntrypoint, nodeExecutableCandidates, runCli, selectFrameworkNode } = await import(
  '../../packages/oxiquill/src/cli/commands.mjs'
);
const { parseConfigOption } = await import('../../packages/oxiquill/src/cli/config-option.mjs');
const testRoot = path.parse(process.cwd()).root;

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

    await runCli('help', [], { cwd: repoRoot, runCommand: vi.fn() });

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

    expect(
      canLoadNativePackage('/usr/bin/node', '/repo/node_modules/rollup', { cwd: '/repo', env: {}, spawn })
    ).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['-e', expect.stringContaining('import(process.argv[1])'), '/repo/node_modules/rollup'],
      {
        cwd: '/repo',
        env: {},
        stdio: 'ignore'
      }
    );
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
    const selectNode = vi.fn()
      .mockReturnValueOnce(firstNode)
      .mockReturnValueOnce(secondNode);
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
});

function fakeNodeExecutable(directory) {
  return path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
}
