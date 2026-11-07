import { createHash, randomUUID } from 'node:crypto';
import * as defaultFileSystem from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { preflightCleanupOwnership } from './cleanup-ownership.mjs';
import { describeRuntimeLock, parseRuntimeLockRecord } from './runtime-lock-record.mjs';

function installedVersion() {
  return JSON.parse(defaultFileSystem.readFileSync(new URL('../../package.json', import.meta.url))).version;
}

export function readRuntimeLock(lockPath, fileSystem = defaultFileSystem) {
  try {
    return { exists: true, record: parseRuntimeLockRecord(fileSystem.readFileSync(lockPath, 'utf8')) };
  } catch (error) {
    return { exists: error.code !== 'ENOENT', record: undefined };
  }
}

export function isDeadRuntimeOwner(record, { host, process: processInterface }) {
  if (!record || record.host !== host) return false;
  try {
    processInterface.kill(record.pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export function hasInheritedRuntimeLock({ paths, env = process.env, fileSystem = defaultFileSystem }) {
  const token = env.OXIQUILL_LOCK_TOKEN;
  return Boolean(
    token && readRuntimeLock(path.join(paths.cacheDir, 'runtime.lock'), fileSystem).record?.token === token
  );
}

// All filesystem steps are synchronous so exit handlers can use the same token-checked release.
// Only polling yields; runtime compilation and generation remain asynchronous.
export async function acquireRuntimeLock({
  paths,
  configFile = undefined,
  command,
  timeout = 1800,
  signal = undefined,
  fileSystem = defaultFileSystem,
  process: processInterface = process,
  host = hostname(),
  version = undefined,
  now = Date.now,
  random = randomUUID,
  delay = (milliseconds, abortSignal) => setTimeout(milliseconds, undefined, { signal: abortSignal }),
  log = console.error,
  preflight = preflightCleanupOwnership
}) {
  if (!(timeout >= 0) || (timeout !== Infinity && !Number.isFinite(timeout))) {
    throw new TypeError('Runtime lock timeout must be a nonnegative number of seconds.');
  }
  signal?.throwIfAborted();
  const lockPath = path.join(paths.cacheDir, 'runtime.lock');
  const started = now();
  const record = Object.freeze({
    token: random(),
    pid: processInterface.pid,
    host,
    command,
    startedAt: new Date(started).toISOString(),
    oxiquillVersion: version ?? installedVersion()
  });
  const candidatePath = `${lockPath}.candidate-${record.token}`;
  let candidateCreated = false;
  let reported = false;
  let remindedAt = started;
  let checkedPaths = false;

  async function beforeWrite() {
    if (checkedPaths) return;
    await preflight({ configFile, fields: ['cacheDir'], paths });
    signal?.throwIfAborted();
    checkedPaths = true;
  }

  function candidate() {
    if (!candidateCreated) {
      fileSystem.mkdirSync(paths.cacheDir, { recursive: true });
      const descriptor = fileSystem.openSync(candidatePath, 'wx');
      candidateCreated = true;
      try {
        fileSystem.writeFileSync(descriptor, `${JSON.stringify(record)}\n`);
      } finally {
        fileSystem.closeSync(descriptor);
      }
    }
    return candidatePath;
  }

  try {
    for (;;) {
      signal?.throwIfAborted();
      const holder = readRuntimeLock(lockPath, fileSystem);
      if (!holder.exists) {
        await beforeWrite();
        try {
          fileSystem.linkSync(candidate(), lockPath);
          return createLease({ lockPath, record, fileSystem, processInterface });
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } else if (isDeadRuntimeOwner(holder.record, { host, process: processInterface })) {
        await beforeWrite();
        if (
          reclaimRuntimeLock({
            lockPath,
            holder: holder.record,
            candidate,
            record,
            fileSystem,
            processInterface,
            host,
            random
          })
        )
          continue;
      }

      const current = readRuntimeLock(lockPath, fileSystem);
      if (!current.exists) continue;
      const description = describeRuntimeLock(lockPath, current.record, host);
      if (!reported) {
        log(`${description} Waiting for release.`);
        reported = true;
      }
      const elapsed = now() - started;
      if (elapsed >= timeout * 1000) {
        throw new Error(`${description} Timed out (--lock-timeout ${timeout}).`);
      }
      if (now() - remindedAt >= 30_000) {
        log(`[oxiquill] Still waiting for runtime lock ${lockPath}.`);
        remindedAt = now();
      }
      await delay(Math.min(100, timeout * 1000 - elapsed), signal);
    }
  } finally {
    if (candidateCreated) unlinkIfPresent(candidatePath, fileSystem);
  }
}

function reclaimRuntimeLock({ lockPath, holder, candidate, record, fileSystem, processInterface, host, random }) {
  const claims = [];
  const visited = new Set();
  let predecessor = holder;
  for (;;) {
    if (visited.has(predecessor.token)) return false;
    visited.add(predecessor.token);
    const identity = createHash('sha256').update(predecessor.token).digest('hex');
    const claimPath = `${lockPath}.reclaim-${identity}`;
    try {
      fileSystem.linkSync(candidate(), claimPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const claim = readRuntimeLock(claimPath, fileSystem);
      if (!claim.exists) {
        visited.delete(predecessor.token);
        continue;
      }
      if (!isDeadRuntimeOwner(claim.record, { host, process: processInterface })) return false;
      // Never overwrite a reclamation claim. Elect a successor for an abandoned claim.
      claims.push({ path: claimPath, token: claim.record.token });
      predecessor = claim.record;
      continue;
    }
    try {
      // A delayed contender must not rename a new holder's lock after another reclaimer won.
      if (readRuntimeLock(lockPath, fileSystem).record?.token !== holder.token) return false;
      const stalePath = `${lockPath}.stale-${random()}`;
      try {
        fileSystem.renameSync(lockPath, stalePath);
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      removeIfOwned(stalePath, holder.token, fileSystem);
      return true;
    } finally {
      claims.forEach((claim) => removeIfOwned(claim.path, claim.token, fileSystem));
      removeIfOwned(claimPath, record.token, fileSystem);
    }
  }
}

function removeIfOwned(filePath, token, fileSystem) {
  if (readRuntimeLock(filePath, fileSystem).record?.token !== token) return;
  unlinkIfPresent(filePath, fileSystem);
}

function unlinkIfPresent(filePath, fileSystem) {
  try {
    fileSystem.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function createLease({ lockPath, record, fileSystem, processInterface }) {
  const children = new Set();
  let stopping = false;
  const stopChild = ({ child, detached }, signal) => {
    try {
      if (detached && child.pid) processInterface.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const onExit = () => {
    children.forEach((child) => stopChild(child, 'SIGKILL'));
    releaseNow();
  };
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    const finish = () => {
      releaseNow();
      processInterface.kill(processInterface.pid, signal);
    };
    if (children.size === 0) return finish();
    children.forEach((child) => stopChild(child, signal));
    const force = globalThis.setTimeout(() => children.forEach((child) => stopChild(child, 'SIGKILL')), 5000);
    force.unref();
    void Promise.all(Array.from(children, ({ done }) => done)).then(() => {
      clearTimeout(force);
      finish();
    });
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  const releaseNow = () => {
    processInterface.removeListener('exit', onExit);
    processInterface.removeListener('SIGINT', onInterrupt);
    processInterface.removeListener('SIGTERM', onTerminate);
    removeIfOwned(lockPath, record.token, fileSystem);
  };
  const release = () => {
    if (!stopping || children.size === 0) releaseNow();
  };
  const trackChild = (child, detached = false) => {
    const entry = { child, detached, done: new Promise((resolve) => child.once('close', resolve)) };
    children.add(entry);
    void entry.done.then(() => {
      // A terminated compiler can leave descendants after its own exit.
      if (stopping && detached) stopChild(entry, 'SIGKILL');
      children.delete(entry);
    });
  };
  processInterface.once('exit', onExit);
  processInterface.once('SIGINT', onInterrupt);
  processInterface.once('SIGTERM', onTerminate);
  return Object.freeze({ token: record.token, lockPath, release, trackChild });
}

export async function withRuntimeLock(options, action) {
  const lease = await acquireRuntimeLock(options);
  try {
    return await action(lease);
  } finally {
    lease.release();
  }
}

export function trackRuntimeCommand(runCommand, trackChild) {
  return trackChild ? (command, args, options) => runCommand(command, args, { ...options, trackChild }) : runCommand;
}
