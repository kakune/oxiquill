import { dependencyOrder, dependentIds } from './cell-graph.mjs';
import { restoreSharedInputs, sharedInputsParameter } from './input-sharing.js';
import { initialValues, reconcileInputValues } from './interactive-cell-model.js';
import { createLatestRequestScheduler } from './interactive-cell-scheduler.js';
import {
  createProducerResultCache,
  resultHash,
  canonicalSerialize,
  type ProducerResult
} from './producer-result-cache.js';
import { runInteractiveCell } from './runtime-client.js';
import { boundedErrorMessage } from './output-limits.mjs';
import { CellExecutionError } from './execution-error.js';
import { ExecutionCancellationError } from './execution-cancellation.js';
import { validateCellExports } from './cell-exports.js';
import { getManifestSnapshot, subscribeManifest } from './manifest.js';
import type { NormalizedCellExecutionResult } from './output-artifacts.js';
import type { CellManifest, InputValues, PageCellManifest } from './types.js';

export type UpstreamFailure = { id: string; title: string; diagnostic: string };
export type PageCellState = {
  values: InputValues;
  invalid: ReadonlySet<string>;
  revision: number;
  inputRevision: number;
  status: 'idle' | 'running' | 'success' | 'error';
  stale: boolean;
  upstreamChanged?: boolean;
  upstreamFailure?: UpstreamFailure;
  error?: string;
  partialResult?: NormalizedCellExecutionResult;
  result?: NormalizedCellExecutionResult;
  fingerprint?: string;
  reused?: boolean;
};
type NodeRun =
  | { success: true; value: ProducerResult }
  | { success: false; error: string; upstream?: UpstreamFailure; partialResult?: NormalizedCellExecutionResult };
type GraphRequest = { roots: readonly string[]; force: readonly string[] };
type GraphRun = { runs: Map<string, NodeRun>; revisions: Map<string, number>; identities: Map<string, string> };
type StoreOptions = {
  execute?: typeof runInteractiveCell;
  hash?: typeof resultHash;
  restore?: typeof restoreSharedInputs;
  cacheBytes?: number;
};

export function createPageCellStore(
  initial: PageCellManifest,
  { execute = runInteractiveCell, hash = resultHash, restore = restoreSharedInputs, cacheBytes }: StoreOptions = {}
) {
  let manifest = initial;
  let disposed = false;
  const cells = new Map(initial.cells.map((cell) => [cell.id, cell]));
  const state = new Map<string, PageCellState>(
    initial.cells.map((cell) => [
      cell.id,
      {
        values: restore(cell),
        invalid: new Set<string>(),
        revision: 0,
        inputRevision: 0,
        status: 'idle',
        stale: false
      }
    ])
  );
  const listeners = new Set<() => void>();
  const cache = createProducerResultCache({ hash, maxBytes: cacheBytes });
  const started = new Set<string>();
  const schedulers = new Map<
    string,
    {
      request: GraphRequest;
      active: boolean;
      scheduler: ReturnType<typeof createLatestRequestScheduler<GraphRequest, GraphRun>>;
    }
  >();
  const moduleFor = (id: string) => manifest.rust?.modules.find((module) => module.cells.includes(id));
  const identity = (cell: CellManifest) =>
    canonicalSerialize([
      cell.source,
      cell.producerFingerprint,
      cell.dependsOn,
      cell.exports,
      cell.inputs,
      moduleFor(cell.id)?.fingerprint
    ]);
  const notify = () => {
    if (!disposed) for (const listener of listeners) listener();
  };
  const get = (id: string) => {
    const value = state.get(id);
    if (!value) throw new Error(`Unknown cell ${id}`);
    return value;
  };
  const update = (id: string, change: Partial<PageCellState>) => state.set(id, { ...get(id), ...change });
  const cellFor = (id: string) => {
    const cell = cells.get(id);
    if (!cell) throw new Error(`Unknown cell ${id}`);
    return cell;
  };
  const allCells = () => [...cells.values()];
  const closure = (roots: readonly string[]) => dependencyOrder(allCells(), roots);
  const descendants = (id: string) => dependentIds(allCells(), id);
  const rootsFor = (id: string) => [id, ...descendants(id).filter((child) => cells.get(child)?.run === 'reactive')];

  async function compute(request: GraphRequest, signal: AbortSignal): Promise<GraphRun> {
    const plan = closure(request.roots);
    const revisions = new Map(plan.map((cell) => [cell.id, get(cell.id).revision]));
    const identities = new Map(plan.map((cell) => [cell.id, identity(cell)]));
    const snapshots = new Map(plan.map((cell) => [cell.id, { ...get(cell.id).values }]));
    const runs = new Map<string, NodeRun>();
    for (const cell of plan) {
      if (signal.aborted) throw new ExecutionCancellationError();
      const upstream = Object.values(cell.dependsOn ?? {})
        .map(({ cell: id }) => {
          const run = runs.get(id);
          if (!run || run.success) return undefined;
          return run.upstream ?? { id, title: cells.get(id)?.title ?? id, diagnostic: run.error };
        })
        .find((failure) => failure !== undefined);
      if (upstream) {
        runs.set(cell.id, { success: false, error: `Upstream cell "${upstream.title}" failed`, upstream });
        continue;
      }
      try {
        if (get(cell.id).invalid.size) throw new Error(`Cell ${cell.title} has invalid inputs`);
        const dependencies = Object.fromEntries(
          Object.entries(cell.dependsOn ?? {}).map(([name, { cell: id }]) => {
            const run = runs.get(id);
            return [name, run?.success ? (run.value.result.exports ?? {}) : {}];
          })
        );
        const dependencyFingerprints = Object.entries(cell.dependsOn ?? {}).map(([name, { cell: id }]) => {
          const run = runs.get(id);
          return [name, run?.success ? run.value.fingerprint : undefined];
        });
        const values = snapshots.get(cell.id) ?? {};
        const key = await hash([
          cell.producerFingerprint ?? cell.source,
          moduleFor(cell.id)?.fingerprint,
          values,
          cell.exports ?? [],
          dependencyFingerprints
        ]);
        if (signal.aborted) throw new ExecutionCancellationError();
        const run = async (runSignal: AbortSignal) => {
          const result = await execute(
            cell,
            values,
            moduleFor(cell.id)?.fingerprint,
            runSignal,
            undefined,
            undefined,
            moduleFor(cell.id),
            dependencies
          );
          const exports = validateCellExports(result.exports, cell);
          return { ...result, ...(exports ? { exports } : {}) };
        };
        const completed =
          cell.cache === 'inputs'
            ? await cache.acquire(cell.id, key, run, signal, request.force.includes(cell.id))
            : await run(signal).then(async (result) => ({
                result,
                fingerprint: await hash([key, result]),
                reused: false
              }));
        runs.set(cell.id, { success: true, value: completed });
      } catch (error) {
        if (signal.aborted) throw new ExecutionCancellationError();
        runs.set(cell.id, {
          success: false,
          error: boundedErrorMessage(error),
          partialResult: error instanceof CellExecutionError ? error.partialResult : undefined
        });
      }
    }
    return { runs, revisions, identities };
  }

  function publish(run: GraphRun): void {
    if (
      disposed ||
      [...run.revisions].some(([id, revision]) => get(id).revision !== revision) ||
      [...run.identities].some(([id, snapshot]) => !cells.has(id) || identity(cellFor(id)) !== snapshot)
    )
      return;
    // Results and the stale marks on previously published descendants form one
    // notification batch. Retained exports are never read during execution.
    for (const [id, result] of run.runs) {
      if (result.success && get(id).fingerprint !== result.value.fingerprint)
        for (const child of descendants(id))
          if (!run.runs.has(child)) update(child, { stale: true, upstreamChanged: true });
    }
    for (const [id, result] of run.runs) {
      if (result.success) {
        update(id, {
          status: 'success',
          result: result.value.result,
          fingerprint: result.value.fingerprint,
          reused: result.value.reused,
          stale: false,
          error: undefined,
          partialResult: undefined,
          upstreamFailure: undefined,
          upstreamChanged: false
        });
      } else {
        update(id, {
          status: 'error',
          stale: Boolean(get(id).result),
          error: result.error,
          partialResult: result.partialResult,
          upstreamFailure: result.upstream,
          reused: false
        });
      }
    }
    notify();
  }

  function schedule(id: string, roots: readonly string[], force: readonly string[] = [], delay = 0): void {
    if (disposed) return;
    const request = { roots, force };
    let entry = schedulers.get(id);
    if (!entry) {
      const scheduler = createLatestRequestScheduler<GraphRequest, GraphRun>({
        execute: compute,
        onResult: (run) => {
          const entry = schedulers.get(id);
          if (entry) entry.active = false;
          publish(run);
        },
        onScheduled: () => {
          const entry = schedulers.get(id);
          if (entry) entry.active = true;
          for (const cell of closure(schedulers.get(id)?.request.roots ?? roots))
            update(cell.id, {
              status: 'running',
              stale: Boolean(get(cell.id).result),
              error: undefined,
              upstreamFailure: undefined,
              partialResult: undefined
            });
          notify();
        },
        onError: (error) => {
          const entry = schedulers.get(id);
          if (entry) entry.active = false;
          update(id, { status: 'error', error: boundedErrorMessage(error) });
          notify();
        },
        onCancelled: () => {
          const entry = schedulers.get(id);
          if (entry) entry.active = false;
          update(id, { status: 'idle', stale: Boolean(get(id).result) });
          notify();
        }
      });
      entry = { request, scheduler, active: false };
      schedulers.set(id, entry);
    }
    entry.request = request;
    entry.scheduler.schedule(request, delay);
  }

  function changed(id: string, shouldSchedule = true): void {
    const affected = new Set([id, ...descendants(id)]);
    const restart: [string, GraphRequest][] = [];
    const abandoned = new Set<string>();
    for (const [owner, entry] of schedulers) {
      if (closure(entry.request.roots).some((cell) => cell.id === id)) {
        entry.scheduler.cancel();
        if (entry.active) {
          for (const cell of closure(entry.request.roots)) abandoned.add(cell.id);
          if (owner !== id) restart.push([owner, entry.request]);
        }
        entry.active = false;
      }
    }
    for (const child of abandoned) {
      const stillNeeded = [...schedulers.values()].some(
        (entry) => entry.active && closure(entry.request.roots).some((cell) => cell.id === child)
      );
      if (!stillNeeded) update(child, { status: 'idle', stale: Boolean(get(child).result) });
    }
    for (const child of affected)
      update(child, {
        stale: Boolean(get(child).result),
        upstreamChanged: child !== id,
        status: 'idle',
        error: undefined,
        upstreamFailure: undefined,
        partialResult: undefined,
        reused: false
      });
    notify();
    const cell = cellFor(id);
    if (shouldSchedule && !get(id).invalid.size && (cell.exports?.length || cell.run === 'reactive'))
      schedule(id, rootsFor(id), [], 150);
    for (const [owner, request] of restart) {
      if (shouldSchedule && !get(id).invalid.size && !(cell.exports?.length && rootsFor(id).includes(owner)))
        schedule(owner, request.roots, request.force, 150);
    }
  }

  function setValues(id: string, values: InputValues, replace = false): void {
    const previous = get(id);
    update(id, {
      values: { ...values },
      invalid: replace ? new Set() : previous.invalid,
      revision: previous.revision + 1,
      inputRevision: previous.inputRevision + Number(replace)
    });
    changed(id);
  }
  function setValidity(id: string, name: string, valid: boolean): void {
    const previous = get(id);
    if (previous.invalid.has(name) === !valid) return;
    const invalid = new Set(previous.invalid);
    if (valid) invalid.delete(name);
    else invalid.add(name);
    update(id, { invalid, revision: previous.revision + 1 });
    changed(id, false);
  }
  function run(id: string, recompute = false): void {
    if (get(id).invalid.size) return;
    const cell = cellFor(id);
    if (cell.exports?.length) {
      for (const child of descendants(id)) update(child, { stale: Boolean(get(child).result), upstreamChanged: true });
    }
    schedule(
      id,
      cell.exports?.length ? rootsFor(id) : [id],
      recompute || (cell.cache && cell.run === 'button') ? [id] : []
    );
  }
  function start(id: string): void {
    if (started.has(id)) return;
    started.add(id);
    if (get(id).status === 'idle' && cells.get(id)?.run !== 'button') schedule(id, [id]);
  }
  function reconcile(next: PageCellManifest): void {
    const oldIdentities = new Map([...cells].map(([id, cell]) => [id, identity(cell)]));
    const previousCells = new Map(cells);
    manifest = next;
    const nextIds = new Set(next.cells.map((cell) => cell.id));
    for (const id of cells.keys())
      if (!nextIds.has(id)) {
        schedulers.get(id)?.scheduler.dispose();
        schedulers.delete(id);
        cache.clearProducer(id);
        state.delete(id);
        started.delete(id);
      }
    // Install the whole graph before invalidating anything: an HMR update may
    // introduce a producer referenced by an earlier cell in manifest order.
    cells.clear();
    for (const cell of next.cells) {
      cells.set(cell.id, cell);
      if (!state.has(cell.id))
        state.set(cell.id, {
          values: restore(cell),
          invalid: new Set(),
          revision: 0,
          inputRevision: 0,
          status: 'idle',
          stale: false
        });
    }
    const changedIds = next.cells
      .filter((cell) => oldIdentities.has(cell.id) && oldIdentities.get(cell.id) !== identity(cell))
      .map((cell) => cell.id);
    for (const cell of next.cells) {
      if (changedIds.includes(cell.id)) {
        cache.clearProducer(cell.id);
        update(cell.id, {
          values: reconcileInputValues(cell.inputs, get(cell.id).values),
          invalid: new Set(),
          revision: get(cell.id).revision + 1,
          inputRevision: get(cell.id).inputRevision + 1
        });
        changed(cell.id, false);
      } else if (previousCells.get(cell.id)?.cache !== cell.cache) cache.clearProducer(cell.id);
    }
    for (const id of changedIds) {
      const cell = cellFor(id);
      const activeReactiveDescendants = descendants(id).some(
        (child) => cellFor(child).run === 'reactive' && (started.has(child) || get(child).result)
      );
      if ((started.has(id) && cell.run !== 'button') || (cell.exports?.length && activeReactiveDescendants))
        schedule(id, rootsFor(id));
    }
    notify();
  }
  function recordIndependent(
    id: string,
    runtime: {
      values: InputValues;
      inputsValid: boolean;
      isRunning: boolean;
      isComplete: boolean;
      isStale: boolean;
      inputRevision: number;
      result?: NormalizedCellExecutionResult;
      error?: string;
      partialResult?: NormalizedCellExecutionResult;
    }
  ): void {
    const previous = get(id);
    const status = runtime.isRunning
      ? 'running'
      : runtime.error !== undefined
        ? 'error'
        : runtime.isComplete
          ? 'success'
          : 'idle';
    const inputsChanged =
      canonicalSerialize(previous.values) !== canonicalSerialize(runtime.values) ||
      Boolean(previous.invalid.size) === runtime.inputsValid;
    if (
      !inputsChanged &&
      previous.result === runtime.result &&
      previous.status === status &&
      previous.error === runtime.error &&
      previous.stale === runtime.isStale
    )
      return;
    update(id, {
      values: { ...runtime.values },
      invalid: runtime.inputsValid ? new Set() : new Set(['invalid']),
      revision: previous.revision + Number(inputsChanged),
      inputRevision: runtime.inputRevision,
      status,
      result: runtime.result,
      error: runtime.error,
      partialResult: runtime.partialResult,
      stale: runtime.isStale
    });
    notify();
  }
  function dispose(): void {
    disposed = true;
    for (const { scheduler } of schedulers.values()) scheduler.dispose();
    schedulers.clear();
    cache.dispose();
    listeners.clear();
  }
  return {
    get,
    run,
    start,
    setValues,
    setValidity,
    reconcile,
    dispose,
    recordIndependent,
    reset: (id: string) => setValues(id, initialValues(cellFor(id).inputs), true),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

export type PageCellStore = ReturnType<typeof createPageCellStore>;
const stores = new Map<string, { store: PageCellStore; dispose: () => void }>();

export function getPageCellStore(cell: CellManifest): PageCellStore {
  const existing = stores.get(cell.pagePath);
  if (existing) return existing.store;
  const payload = [...globalThis.document.querySelectorAll<HTMLScriptElement>('script[data-oxiquill-page]')].find(
    (element) => element.dataset.oxiquillPage === cell.pagePath
  );
  const snapshot = getManifestSnapshot();
  const initial = payload ? (JSON.parse(payload.textContent ?? '{}') as PageCellManifest) : { cells: [cell] };
  const store = createPageCellStore(initial);
  const reconcile = () => {
    const next = getManifestSnapshot();
    const cells = next.cells.filter((candidate) => candidate.pagePath === cell.pagePath);
    if (cells.length) store.reconcile({ cells, rust: next.rust });
  };
  if (snapshot.cells.some((candidate) => candidate.pagePath === cell.pagePath)) reconcile();
  const unsubscribe = subscribeManifest(reconcile);
  let previousQuery = new URL(globalThis.location.href).searchParams.getAll(sharedInputsParameter).join('\0');
  const restore = () => {
    const query = new URL(globalThis.location.href).searchParams.getAll(sharedInputsParameter).join('\0');
    if (query === previousQuery) return;
    previousQuery = query;
    const current = getManifestSnapshot().cells.filter((candidate) => candidate.pagePath === cell.pagePath);
    for (const candidate of current.length ? current : initial.cells)
      store.setValues(
        candidate.id,
        restoreSharedInputs(candidate, globalThis.location.href, store.get(candidate.id).values),
        true
      );
  };
  const dispose = () => {
    store.dispose();
    unsubscribe();
    stores.delete(cell.pagePath);
    globalThis.removeEventListener('popstate', restore);
    globalThis.removeEventListener('pagehide', dispose);
    globalThis.document.removeEventListener('astro:before-swap', dispose);
  };
  globalThis.addEventListener('popstate', restore);
  globalThis.addEventListener('pagehide', dispose);
  globalThis.document.addEventListener('astro:before-swap', dispose);
  stores.set(cell.pagePath, { store, dispose });
  return store;
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    for (const { dispose } of stores.values()) dispose();
  });
