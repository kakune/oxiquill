// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

const { runCli } = await import('../../packages/oxiquill/src/cli/index.mjs');

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
});
