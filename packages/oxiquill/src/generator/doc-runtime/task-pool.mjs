import os from 'node:os';

// Runs at most `limit` tasks at once in submission order. `idle()` settles after
// every submitted task, and task failures stay with their own promise.
export function createTaskPool(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Task pool limit must be a positive integer.');
  const queue = [];
  const pending = new Set();
  let active = 0;
  let maxActive = 0;
  const next = () => {
    while (active < limit && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      maxActive = Math.max(maxActive, active);
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          next();
        });
    }
  };
  return Object.freeze({
    run(task) {
      const promise = new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
      const settled = promise.then(
        () => {},
        () => {}
      );
      pending.add(settled);
      settled.finally(() => pending.delete(settled));
      return promise;
    },
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
    get maxActive() {
      return maxActive;
    }
  });
}

// Post-link work follows Cargo's job setting: a positive CARGO_BUILD_JOBS is a
// limit, a negative value leaves that many CPUs free, and otherwise every
// available CPU (respecting process affinity) is used.
export function postLinkParallelism(environment = process.env, available = os.availableParallelism()) {
  const cores = Math.max(1, available);
  const jobs = String(environment.CARGO_BUILD_JOBS ?? '').trim();
  const pool = /^[1-9]\d*$/u.test(jobs)
    ? Number(jobs)
    : /^-[1-9]\d*$/u.test(jobs)
      ? Math.max(1, cores + Number(jobs))
      : cores;
  return { pool, cores };
}

// A single stale module may use every core; several share them.
export function wasmOptThreads({ cores, pool, staleCount }) {
  return Math.max(1, Math.floor(cores / Math.max(1, Math.min(pool, staleCount))));
}
