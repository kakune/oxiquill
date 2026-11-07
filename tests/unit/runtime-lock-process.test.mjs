// @vitest-environment node
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { acquireRuntimeLock } from '../../packages/oxiquill/src/generator/runtime-lock.mjs';
import { prepareCleanupOwnership } from '../../packages/oxiquill/src/generator/cleanup-ownership.mjs';

const fixturePath = fileURLToPath(new URL('../fixtures/runtime-lock-child.mjs', import.meta.url));
const children = [];
const roots = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async ({ child, exit }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    })
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-lock-process-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  await mkdir(paths.docsDir, { recursive: true });
  await writeFile(path.join(paths.docsDir, 'index.mdx'), 'first');
  await prepareCleanupOwnership({ paths });
  return { root, paths };
}

function start(mode, root, args = []) {
  const child = fork(fixturePath, [mode, root, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  const history = [];
  const pending = [];
  let errors = '';
  child.stderr.on('data', (data) => {
    errors += data;
  });
  child.stdout.resume();
  child.on('message', (message) => {
    history.push(message);
    pending.slice().forEach((request) => {
      if (request.type === message.type) {
        pending.splice(pending.indexOf(request), 1);
        request.resolve(message);
      } else if (message.type === 'error') request.reject(new Error(message.message));
    });
  });
  const exit = once(child, 'exit');
  exit.then(([code, signal]) =>
    pending.splice(0).forEach(({ reject }) => reject(new Error(`Child exited ${code ?? signal}: ${errors}`)))
  );
  const api = {
    child,
    exit,
    history,
    send: (type) => child.send({ type }),
    next: (type) => new Promise((resolve, reject) => pending.push({ type, resolve, reject })),
    async exchange(type, response) {
      const promise = api.next(response);
      api.send(type);
      return promise;
    }
  };
  children.push(api);
  return api;
}

describe('cross-process runtime serialization', () => {
  it.each(['0', '0.1'])(
    'leaves a held project unchanged when clean times out after %s seconds',
    async (timeout) => {
      const { root, paths } = await project();
      const lease = await acquireRuntimeLock({ paths, command: 'holder' });
      try {
        const before = await readdir(paths.cacheDir);
        const record = await readFile(lease.lockPath, 'utf8');
        const clean = start('clean', root, ['--lock-timeout', timeout]);
        expect((await clean.next('error')).message).toContain(`--lock-timeout ${timeout}`);
        await clean.exit;
        expect(await readdir(paths.cacheDir)).toEqual(before);
        expect(await readFile(lease.lockPath, 'utf8')).toBe(record);
      } finally {
        lease.release();
      }
    },
    20_000
  );

  it.skipIf(process.platform === 'win32')(
    'holds check --watch after the checker returns and releases on SIGTERM',
    async () => {
      const { root, paths } = await project();
      const check = start('check-watch', root);
      await check.next('stage');
      let phasePromise = check.next('phase');
      check.send('finish-generation');
      expect((await phasePromise).name).toBe('sync');
      phasePromise = check.next('phase');
      check.send('continue');
      expect((await phasePromise).name).toBe('check');
      check.send('continue');
      await expect(
        acquireRuntimeLock({ paths, command: 'contender', timeout: 0, log: () => undefined })
      ).rejects.toThrow('Timed out');
      check.child.kill('SIGTERM');
      await check.exit;
      expect(existsSync(path.join(paths.cacheDir, 'runtime.lock'))).toBe(false);
    },
    20_000
  );

  it.skipIf(process.platform === 'win32')(
    'stops active child work before releasing on SIGTERM',
    async () => {
      const { root, paths } = await project();
      const holder = start('holder-with-child', root);
      await holder.next('acquired');
      holder.child.kill('SIGTERM');
      await holder.exit;
      expect(await readFile(path.join(root, 'child-stopped-with-lock'), 'utf8')).toBe('true');
      expect(existsSync(path.join(paths.cacheDir, 'runtime.lock'))).toBe(false);
    },
    20_000
  );

  it.each(['check', 'build'])(
    'coalesces dev changes while %s generates and consumes one generation',
    async (command) => {
      const { root, paths } = await project();
      const cli = start(command, root);
      const stage = await cli.next('stage');
      const watcher = start('watcher', root);
      await watcher.next('ready');
      const waiting = watcher.next('waiting');
      await watcher.exchange('change', 'event');
      await waiting;
      await writeFile(path.join(paths.docsDir, 'index.mdx'), 'second');
      await watcher.exchange('change', 'event');
      await writeFile(path.join(paths.docsDir, 'index.mdx'), 'latest');
      await watcher.exchange('change', 'event');
      stage.stagePaths.forEach((stagePath) => expect(existsSync(stagePath)).toBe(true));
      expect(watcher.history.filter(({ type }) => type === 'generated')).toHaveLength(0);
      const synchronized = watcher.next('generated');
      const firstPhase = cli.next('phase');
      cli.send('finish-generation');
      let phase = await firstPhase;
      const token = phase.token;
      for (const name of command === 'build' ? ['sync', 'check', 'build'] : ['sync', 'check']) {
        expect(phase).toMatchObject({ name, outputs: ['first', 'first'], token, owner: 'cli', holder: { token } });
        const next = cli.next(name === (command === 'build' ? 'build' : 'check') ? 'done' : 'phase');
        cli.send('continue');
        phase = await next;
      }
      expect(await synchronized).toMatchObject({ state: 'latest', outputs: ['latest', 'latest'] });
      await watcher.exchange('close', 'closed');
      expect(watcher.history.filter(({ type }) => type === 'generated')).toHaveLength(1);
      expect(existsSync(path.join(paths.cacheDir, 'runtime.lock'))).toBe(false);
    },
    20_000
  );

  it('prevents clean from deleting a live build stage or its consumed output', async () => {
    const { root, paths } = await project();
    const build = start('build', root);
    const stage = await build.next('stage');
    const clean = start('clean', root);
    await clean.next('waiting');
    stage.stagePaths.forEach((stagePath) => expect(existsSync(stagePath)).toBe(true));
    const done = clean.next('done');
    let phasePromise = build.next('phase');
    build.send('finish-generation');
    for (const name of ['sync', 'check', 'build']) {
      const phase = await phasePromise;
      expect(phase).toMatchObject({ name, outputs: ['first', 'first'] });
      phasePromise = build.next(name === 'build' ? 'done' : 'phase');
      build.send('continue');
    }
    await phasePromise;
    expect(await done).toMatchObject({ outputs: [null, null] });
    expect(existsSync(paths.cacheDir)).toBe(true);
    expect(existsSync(path.join(paths.cacheDir, 'runtime.lock'))).toBe(false);
  }, 20_000);

  it('reclaims an abruptly killed holder, with only one winner among competing reclaimers', async () => {
    const { root, paths } = await project();
    const holder = start('holder', root);
    await holder.next('acquired');
    holder.child.kill('SIGKILL');
    await holder.exit;
    expect(existsSync(path.join(paths.cacheDir, 'runtime.lock'))).toBe(true);
    const contenders = [start('reclaimer-a', root), start('reclaimer-b', root)];
    const winner = await Promise.race(
      contenders.map(async (contender) => {
        await contender.next('acquired');
        return contender;
      })
    );
    const loser = contenders.find((contender) => contender !== winner);
    // The loser cannot acquire until the winner explicitly releases.
    if (!loser.history.some(({ type }) => type === 'waiting')) await loser.next('waiting');
    expect(loser.history.some(({ type }) => type === 'acquired')).toBe(false);
    const acquired = loser.next('acquired');
    await winner.exchange('release', 'released');
    await acquired;
    await loser.exchange('release', 'released');
  }, 20_000);

  it('does not let a delayed stale observer rename a newly acquired live lock', async () => {
    const { root, paths } = await project();
    const lockPath = path.join(paths.cacheDir, 'runtime.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        token: 'dead',
        pid: 2147483647,
        host: hostname(),
        command: 'dead',
        startedAt: new Date().toISOString(),
        oxiquillVersion: '0.4.1'
      })
    );
    const delayed = start('delayed-reclaimer', root);
    await delayed.next('observed-stale');
    const lease = await acquireRuntimeLock({ paths, command: 'live build' });
    try {
      const waiting = delayed.next('waiting');
      await writeFile(path.join(root, `resume-${delayed.child.pid}`), 'go');
      await waiting;
      expect(JSON.parse(await readFile(lockPath, 'utf8')).token).toBe(lease.token);
      const acquired = delayed.next('acquired');
      lease.release();
      await acquired;
      await delayed.exchange('release', 'released');
    } finally {
      lease.release();
    }
  }, 20_000);

  it('cancels a watcher waiting for a live holder without synchronizing', async () => {
    const { root, paths } = await project();
    const lease = await acquireRuntimeLock({ paths, command: 'live build' });
    try {
      const watcher = start('watcher', root);
      await watcher.next('ready');
      const waiting = watcher.next('waiting');
      await watcher.exchange('change', 'event');
      await waiting;
      await watcher.exchange('close', 'closed');
      expect(watcher.history.some(({ type }) => type === 'generated')).toBe(false);
    } finally {
      lease.release();
    }
  }, 20_000);
});
