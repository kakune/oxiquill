// @vitest-environment node

import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const cliPath = fileURLToPath(new URL('../../packages/oxiquill/src/cli/index.mjs', import.meta.url));
const { isCliEntrypoint, runCli } = await import('../../packages/oxiquill/src/cli/index.mjs');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('oxiquill CLI', () => {
  it('can be imported without running the command dispatcher', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runCli('help', [], { cwd: '/repo', runCommand: vi.fn() });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: oxiquill'));
  });

  it('rejects unknown commands', async () => {
    await expect(runCli('unknown', [], { cwd: '/repo', runCommand: vi.fn() })).rejects.toThrow(
      'Unknown oxiquill command "unknown".'
    );
  });

  it('recognizes pnpm-style bin symlinks as the CLI entrypoint', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'oxiquill-cli-'));
    const symlinkPath = path.join(directory, 'oxiquill');

    try {
      await symlink(cliPath, symlinkPath);

      expect(isCliEntrypoint(symlinkPath, pathToFileURL(cliPath).href)).toBe(true);
      expect(isCliEntrypoint('/not/the/cli', pathToFileURL(cliPath).href)).toBe(false);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
