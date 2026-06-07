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
const repoRoot = path.resolve('/repo');
const { canLoadNativePackage, isCliEntrypoint, nodeExecutableCandidates, runCli, selectFrameworkNode } = await import(
  '../../packages/oxiquill/src/cli/commands.mjs'
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('oxiquill CLI', () => {
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
    const exists = (candidate) => ['/bad/bin/node', '/good/bin/node'].includes(candidate);

    expect(
      nodeExecutableCandidates({
        execPath: '/bad/bin/node',
        exists,
        pathValue: ['/bad/bin', '/good/bin'].join(path.delimiter),
        platform: 'linux'
      })
    ).toEqual(['/bad/bin/node', '/good/bin/node']);
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
    const spawn = vi.fn((nodePath) => ({ status: nodePath === '/good/bin/node' ? 0 : 1 }));
    const warn = vi.fn();
    const exists = (candidate) => ['/bad/bin/node', '/good/bin/node'].includes(candidate);

    expect(
      selectFrameworkNode(actualPaths, {
        env: {
          PATH: ['/bad/bin', '/good/bin'].join(path.delimiter)
        },
        execPath: '/bad/bin/node',
        exists,
        spawn,
        warn
      })
    ).toBe('/good/bin/node');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Using /good/bin/node for Astro/Vite'));
  });
});
