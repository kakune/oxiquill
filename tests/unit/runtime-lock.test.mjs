// @vitest-environment node
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import {
  acquireRuntimeLock,
  hasInheritedRuntimeLock,
  isDeadRuntimeOwner,
  readRuntimeLock,
  withRuntimeLock
} from '../../packages/oxiquill/src/generator/runtime-lock.mjs';
import { parseRuntimeLockRecord } from '../../packages/oxiquill/src/generator/runtime-lock-record.mjs';
import { prepareCleanupOwnership } from '../../packages/oxiquill/src/generator/cleanup-ownership.mjs';
import { cleanOxiquillWorkspace } from '../../packages/oxiquill/src/generator/clean.mjs';

const roots = [];
const leases = [];
afterEach(async () => {
  leases.splice(0).forEach((lease) => lease.release());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-lock-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root, ...overrides });
  const lockPath = path.join(paths.cacheDir, 'runtime.lock');
  const options = { paths, command: 'test build', log: vi.fn() };
  const acquire = async (extra = {}) => {
    const lease = await acquireRuntimeLock({ ...options, ...extra });
    leases.push(lease);
    return lease;
  };
  const writeHolder = (record = holder()) => {
    fs.mkdirSync(paths.cacheDir, { recursive: true });
    fs.writeFileSync(lockPath, typeof record === 'string' ? record : JSON.stringify(record));
  };
  return { root, paths, lockPath, options, acquire, writeHolder };
}

function holder(overrides = {}) {
  return {
    token: 'old-token',
    pid: process.pid,
    host: hostname(),
    command: 'other build',
    startedAt: '2020-01-01T00:00:00.000Z',
    oxiquillVersion: '0.4.1',
    ...overrides
  };
}

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    pid: 4321,
    kill: vi.fn((pid) => {
      if (pid !== 4321) throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    })
  });
}

describe('project runtime lock', () => {
  it('atomically publishes a complete holder record and releases idempotently', async () => {
    const { acquire, lockPath, paths } = await fixture();
    const lease = await acquire();
    expect(JSON.parse(fs.readFileSync(lockPath))).toEqual({
      token: lease.token,
      pid: process.pid,
      host: hostname(),
      command: 'test build',
      startedAt: expect.any(String),
      oxiquillVersion: expect.any(String)
    });
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['runtime.lock']);
    expect(hasInheritedRuntimeLock({ paths, env: { OXIQUILL_LOCK_TOKEN: lease.token } })).toBe(true);
    expect(hasInheritedRuntimeLock({ paths, env: { OXIQUILL_LOCK_TOKEN: 'wrong' } })).toBe(false);
    expect(hasInheritedRuntimeLock({ paths, env: {} })).toBe(false);
    lease.release();
    lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it.each([0, 0.2])('times out after %s seconds without writing to a held project', async (timeout) => {
    const { acquire, writeHolder, options, paths, lockPath } = await fixture();
    writeHolder();
    const before = fs.readFileSync(lockPath, 'utf8');
    const writes = vi.fn(fs.writeFileSync);
    let clock = 0;
    await expect(
      acquire({
        timeout,
        fileSystem: { ...fs, writeFileSync: writes },
        now: () => clock,
        delay: async (ms) => {
          clock += ms;
        }
      })
    ).rejects.toThrow(`--lock-timeout ${timeout}`);
    expect(writes).not.toHaveBeenCalled();
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['runtime.lock']);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);
    expect(options.log).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('other build, PID'));
  });

  it('prints 30-second reminders and proceeds when a live holder releases', async () => {
    const { acquire, writeHolder, options, lockPath } = await fixture();
    writeHolder();
    let clock = 0;
    const lease = await acquire({
      timeout: 90,
      now: () => clock,
      delay: async (ms) => {
        clock += ms;
        if (clock >= 30_100) fs.unlinkSync(lockPath);
      }
    });
    expect(lease.token).toBe(readRuntimeLock(lockPath).record.token);
    expect(options.log).toHaveBeenCalledTimes(2);
    expect(options.log.mock.calls[1][0]).toContain('Still waiting');
  });

  it.each(['broken JSON', holder({ host: 'another-host' }), holder({ pid: 999 })])(
    'keeps unknown or indeterminate holders and reports recovery guidance',
    async (record) => {
      const { acquire, writeHolder, lockPath } = await fixture();
      writeHolder(record);
      const processInterface = fakeProcess();
      processInterface.kill.mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      });
      await expect(acquire({ timeout: 0, process: processInterface })).rejects.toThrow('Runtime lock');
      expect(fs.existsSync(lockPath)).toBe(true);
      if (typeof record === 'string' || record.host !== hostname()) {
        await expect(acquire({ timeout: 0 })).rejects.toThrow('remove');
      }
    }
  );

  it('reclaims a dead same-host owner regardless of age and recovers an abandoned reclaim claim', async () => {
    const { acquire, writeHolder, paths, lockPath } = await fixture();
    const dead = holder({ pid: 9876, startedAt: new Date().toISOString() });
    writeHolder(dead);
    const claim = `${lockPath}.reclaim-${createHash('sha256').update(dead.token).digest('hex')}`;
    fs.writeFileSync(claim, JSON.stringify(holder({ token: 'dead-reclaimer', pid: 9877 })));
    const lease = await acquire({ process: fakeProcess() });
    expect(readRuntimeLock(lockPath).record.token).toBe(lease.token);
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['runtime.lock']);
  });

  it('never renames a replacement lock after observing an old stale holder', async () => {
    const { acquire, writeHolder, lockPath } = await fixture();
    writeHolder(holder({ pid: 9876 }));
    const renameSync = vi.fn(fs.renameSync);
    const linkSync = (source, target) => {
      fs.linkSync(source, target);
      if (target.includes('.reclaim-')) writeHolder(holder({ token: 'new-live-owner', pid: 4321 }));
    };
    await expect(
      acquire({ timeout: 0, process: fakeProcess(), fileSystem: { ...fs, linkSync, renameSync } })
    ).rejects.toThrow('Timed out');
    expect(renameSync).not.toHaveBeenCalled();
    expect(readRuntimeLock(lockPath).record.token).toBe('new-live-owner');
  });

  it('cleans up a candidate after losing the publication race', async () => {
    const { acquire, writeHolder, paths } = await fixture();
    const linkSync = () => {
      writeHolder();
      throw Object.assign(new Error('held'), { code: 'EEXIST' });
    };
    await expect(acquire({ timeout: 0, fileSystem: { ...fs, linkSync } })).rejects.toThrow('Timed out');
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['runtime.lock']);
  });

  it('removes an incomplete candidate when writing fails', async () => {
    const { acquire, paths, lockPath } = await fixture();
    await expect(
      acquire({
        fileSystem: {
          ...fs,
          writeFileSync: () => {
            throw new Error('disk full');
          }
        }
      })
    ).rejects.toThrow('disk full');
    expect(fs.readdirSync(paths.cacheDir)).toEqual([]);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not remove a lock when the release token no longer matches', async () => {
    const { acquire, writeHolder, lockPath } = await fixture();
    const lease = await acquire();
    writeHolder(holder({ token: 'replacement' }));
    lease.release();
    expect(readRuntimeLock(lockPath).record.token).toBe('replacement');
  });

  it('retains the lock until active child work closes on termination', async () => {
    const { acquire, lockPath } = await fixture();
    const processInterface = fakeProcess();
    const lease = await acquire({ process: processInterface });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    lease.trackChild(child);
    processInterface.emit('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    lease.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    child.emit('close');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(processInterface.kill).toHaveBeenCalledWith(4321, 'SIGTERM');
  });

  it.each(['SIGINT', 'SIGTERM', 'exit'])('releases on %s and unregisters lifecycle handlers', async (event) => {
    const { acquire, lockPath } = await fixture();
    const processInterface = fakeProcess();
    await acquire({ process: processInterface });
    processInterface.emit(event);
    expect(fs.existsSync(lockPath)).toBe(false);
    if (event !== 'exit') {
      expect(processInterface.kill).toHaveBeenCalledWith(4321, event);
      expect(processInterface.listenerCount('exit')).toBe(0);
    }
  });

  it('notifies signal exit only after tracked children have drained', async () => {
    const { acquire } = await fixture();
    const processInterface = fakeProcess();
    const onSignalExit = vi.fn();
    const lease = await acquire({ process: processInterface, onSignalExit });
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    lease.trackChild(child);
    processInterface.emit('SIGINT');
    expect(onSignalExit).not.toHaveBeenCalled();
    child.emit('close');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(onSignalExit).toHaveBeenCalledExactlyOnceWith('SIGINT');
    expect(processInterface.kill).toHaveBeenCalledWith(4321, 'SIGINT');
  });

  it('releases after compilation failure and preserves the previous output', async () => {
    const { options, paths, lockPath } = await fixture();
    fs.mkdirSync(paths.generatedDir, { recursive: true });
    const manifest = path.join(paths.generatedDir, 'cells.json');
    fs.writeFileSync(manifest, 'previous generation');
    await expect(
      withRuntimeLock(options, async () => {
        throw new Error('compiler failed');
      })
    ).rejects.toThrow('compiler failed');
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('previous generation');
  });

  it('cancels waiting without creating any files', async () => {
    const { acquire, writeHolder, paths } = await fixture();
    writeHolder();
    const controller = new AbortController();
    await expect(
      acquire({
        timeout: Infinity,
        signal: controller.signal,
        delay: async () => {
          controller.abort();
        }
      })
    ).rejects.toThrow('aborted');
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['runtime.lock']);
  });

  it('keeps a custom cache lock and ownership marker throughout cleanup', async () => {
    const { acquire, paths, lockPath } = await fixture({ cacheDir: 'custom-cache' });
    const lease = await acquire();
    await prepareCleanupOwnership({ paths });
    fs.mkdirSync(paths.generatedDir, { recursive: true });
    fs.writeFileSync(path.join(paths.generatedDir, 'cells.json'), 'old');
    await cleanOxiquillWorkspace({ paths, lockToken: lease.token });
    expect(readRuntimeLock(lockPath).record.token).toBe(lease.token);
    expect(fs.readdirSync(paths.cacheDir).sort()).toEqual(['.oxiquill-ownership.json', 'runtime.lock']);
    expect(fs.existsSync(paths.generatedDir)).toBe(false);
    lease.release();
    const next = await acquire();
    expect(next.token).not.toBe(lease.token);
  });

  it("allows a custom cache containing a contender's unfinished temporary record", async () => {
    const { acquire, paths } = await fixture({ cacheDir: 'custom-cache' });
    fs.mkdirSync(paths.cacheDir);
    const candidate = path.join(paths.cacheDir, 'runtime.lock.candidate-11111111-1111-4111-8111-111111111111');
    fs.writeFileSync(candidate, '{');
    const lease = await acquire();
    await prepareCleanupOwnership({ paths });
    await cleanOxiquillWorkspace({ paths, lockToken: lease.token });
    expect(fs.readFileSync(candidate, 'utf8')).toBe('{');
  });

  it('rejects unsafe custom cache contents before creating lock files', async () => {
    const { acquire, paths } = await fixture({ cacheDir: 'custom-cache' });
    fs.mkdirSync(paths.cacheDir);
    fs.writeFileSync(path.join(paths.cacheDir, 'authored.txt'), 'keep');
    await expect(acquire()).rejects.toThrow('custom cleanup target has no');
    expect(fs.readdirSync(paths.cacheDir)).toEqual(['authored.txt']);
  });

  it.each([-1, NaN, '10'])('rejects an invalid internal timeout %s', async (timeout) => {
    const { acquire } = await fixture();
    await expect(acquire({ timeout })).rejects.toThrow('timeout');
  });

  it.each(['null', '{}', '{', JSON.stringify(holder({ pid: -1 })), JSON.stringify(holder({ startedAt: 'bad' }))])(
    'does not trust malformed records %s',
    (source) => expect(parseRuntimeLockRecord(source)).toBeUndefined()
  );

  it('treats unreadable records and successful PID probes conservatively', () => {
    expect(
      readRuntimeLock('/lock', {
        readFileSync: () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      })
    ).toEqual({ exists: true, record: undefined });
    expect(isDeadRuntimeOwner(holder({ pid: 4321 }), { host: hostname(), process: fakeProcess() })).toBe(false);
  });
});
