import { dependencyOrder, dependentIds, isGraphCell } from './cell-graph.mjs';
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
type ChangeOptions = {
  /** Schedules the changed cell and its automatic descendants. */
  schedule?: boolean;
  /** Restarts other requests cancelled by the change. */
  restart?: boolean;
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
  // Roots of a request can outlive a cell removed by HMR; the rest of the request remains valid.
  const closure = (roots: readonly string[]) =>
    dependencyOrder(
      allCells(),
      roots.filter((id) => cells.has(id))
    );
  const closureIds = (roots: readonly string[]) => new Set(closure(roots).map((cell) => cell.id));
  const descendants = (id: string) => dependentIds(allCells(), id);
  // A root can run only when it and every prerequisite have valid inputs.
  const runnable = (id: string) => closure([id]).every((cell) => get(cell.id).invalid.size === 0);
  // Changing a cell refreshes it and every automatic (reactive or autorun) descendant that can run.
  const rootsFor = (id: string) => [
    id,
    ...descendants(id).filter((child) => cells.get(child)?.run !== 'button' && runnable(child))
  ];
  const activeRoots = () =>
    new Set([...schedulers.values()].filter((entry) => entry.active).flatMap((entry) => entry.request.roots));
  // Marks a result whose upstream changed. Cells without a result have nothing to mark.
  const markUpstreamChanged = (id: string) => {
    if (get(id).result) update(id, { stale: true, upstreamChanged: true });
  };
  // Returns abandoned roots that no other active request still computes to `change`.
  const settle = (roots: Iterable<string>, change: (id: string) => Partial<PageCellState>) => {
    const busy = activeRoots();
    for (const root of roots) if (cells.has(root) && !busy.has(root)) update(root, change(root));
  };

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
        // The runtime client validates exports against the cell's declaration.
        const run = (runSignal: AbortSignal) =>
          execute(
            cell,
            values,
            moduleFor(cell.id)?.fingerprint,
            runSignal,
            undefined,
            undefined,
            moduleFor(cell.id),
            dependencies
          );
        // Every node shares identical in-flight work; only `cache: inputs` keeps results.
        const completed = await cache.acquire(cell.id, key, run, signal, {
          force: request.force.includes(cell.id),
          store: cell.cache === 'inputs'
        });
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

  function publish(run: GraphRun): boolean {
    if (
      disposed ||
      [...run.identities].some(([id, snapshot]) => !cells.has(id) || identity(cellFor(id)) !== snapshot) ||
      [...run.revisions].some(([id, revision]) => get(id).revision !== revision)
    )
      return false;
    // Results and the stale marks on previously published descendants form one
    // notification batch. Retained exports are never read during execution.
    for (const [id, result] of run.runs) {
      if (result.success && get(id).fingerprint !== result.value.fingerprint)
        for (const child of descendants(id)) if (!run.runs.has(child)) markUpstreamChanged(child);
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
    return true;
  }

  function schedule(id: string, roots: readonly string[], force: readonly string[] = [], delay = 0): void {
    if (disposed) return;
    const request = { roots, force };
    let entry = schedulers.get(id);
    if (!entry) {
      const finish = (change: (root: string) => Partial<PageCellState>) => {
        const current = schedulers.get(id);
        if (!current) return;
        current.active = false;
        settle(current.request.roots, change);
        notify();
      };
      const scheduler = createLatestRequestScheduler<GraphRequest, GraphRun>({
        execute: compute,
        onResult: (run) => {
          const current = schedulers.get(id);
          if (current) current.active = false;
          // A result that lost its race with an HMR update releases its roots.
          if (!publish(run)) finish((root) => ({ status: 'idle', stale: Boolean(get(root).result) }));
        },
        // Only the requested roots show progress: prerequisites keep their state
        // until the graph publishes, because their own inputs did not change.
        onScheduled: () => {
          const current = schedulers.get(id);
          if (current) current.active = true;
          for (const root of (current?.request.roots ?? roots).filter((candidate) => cells.has(candidate)))
            update(root, {
              status: 'running',
              stale: Boolean(get(root).result),
              error: undefined,
              upstreamFailure: undefined,
              partialResult: undefined
            });
          notify();
        },
        onError: (error) => finish(() => ({ status: 'error', error: boundedErrorMessage(error) })),
        onCancelled: () => finish((root) => ({ status: 'idle', stale: Boolean(get(root).result) }))
      });
      entry = { request, scheduler, active: false };
      schedulers.set(id, entry);
    }
    entry.request = request;
    entry.scheduler.schedule(request, delay);
  }

  function changed(id: string, { schedule: scheduleChanged = true, restart = true }: ChangeOptions = {}): void {
    const affected = new Set([id, ...descendants(id)]);
    const cancelled: [string, GraphRequest][] = [];
    const abandoned = new Set<string>();
    for (const [owner, entry] of schedulers) {
      if (closureIds(entry.request.roots).has(id)) {
        entry.scheduler.cancel();
        if (entry.active) {
          entry.request.roots.forEach((root) => abandoned.add(root));
          if (owner !== id) cancelled.push([owner, entry.request]);
        }
        entry.active = false;
      }
    }
    settle(abandoned, (root) => ({ status: 'idle', stale: Boolean(get(root).result) }));
    for (const child of affected) {
      const hasResult = Boolean(get(child).result);
      update(child, {
        stale: hasResult,
        upstreamChanged: child !== id && hasResult,
        status: 'idle',
        error: undefined,
        upstreamFailure: undefined,
        partialResult: undefined,
        reused: false
      });
    }
    notify();
    const cell = cellFor(id);
    if (scheduleChanged && !get(id).invalid.size && (cell.exports?.length || cell.run === 'reactive'))
      schedule(id, rootsFor(id), [], 150);
    if (!restart) return;
    // Other cancelled requests continue with the roots that can still run, for
    // example when a sibling consumer becomes invalid. Work they share with the
    // new request runs once through the shared in-flight computations.
    for (const [owner, request] of cancelled) {
      const remaining = request.roots.filter((root) => cells.has(root) && runnable(root));
      if (!remaining.length) continue;
      const included = closureIds(remaining);
      schedule(
        owner,
        remaining,
        request.force.filter((forced) => included.has(forced)),
        150
      );
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
    changed(id, { schedule: false });
  }
  // Descendants are marked only when the producer publishes different exports.
  function run(id: string, recompute = false): void {
    if (get(id).invalid.size) return;
    const cell = cellFor(id);
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
    const removed = new Set([...cells.keys()].filter((id) => !nextIds.has(id)));
    for (const id of removed) {
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
    // Requests that named a removed cell continue with their remaining roots.
    for (const [owner, entry] of [...schedulers]) {
      if (!entry.request.roots.some((root) => removed.has(root))) continue;
      const roots = entry.request.roots.filter((root) => cells.has(root));
      const active = entry.active;
      entry.scheduler.cancel();
      entry.active = false;
      if (!roots.length) {
        entry.scheduler.dispose();
        schedulers.delete(owner);
        continue;
      }
      entry.request = { roots, force: entry.request.force.filter((id) => cells.has(id)) };
      if (active) schedule(owner, entry.request.roots, entry.request.force);
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
        changed(cell.id, { schedule: false, restart: false });
      } else if (previousCells.get(cell.id)?.cache !== cell.cache) cache.clearProducer(cell.id);
    }
    for (const id of changedIds) {
      const cell = cellFor(id);
      const activeAutomaticDescendants = descendants(id).some(
        (child) => cellFor(child).run !== 'button' && (started.has(child) || get(child).result)
      );
      if ((started.has(id) && cell.run !== 'button') || (cell.exports?.length && activeAutomaticDescendants))
        schedule(id, rootsFor(id));
    }
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
    has: (id: string) => cells.has(id),
    run,
    start,
    setValues,
    setValidity,
    reconcile,
    dispose,
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

/** The graph cells of one page, as published by the page data block and manifest updates. */
export function pageGraphCells(cells: readonly CellManifest[], pagePath: string): CellManifest[] {
  return cells.filter((candidate) => candidate.pagePath === pagePath && isGraphCell(candidate));
}

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
    const cells = pageGraphCells(next.cells, cell.pagePath);
    if (cells.length) store.reconcile({ cells, rust: next.rust });
  };
  if (pageGraphCells(snapshot.cells, cell.pagePath).length) reconcile();
  const unsubscribe = subscribeManifest(reconcile);
  let previousQuery = new URL(globalThis.location.href).searchParams.getAll(sharedInputsParameter).join('\0');
  // Independent cells restore their own inputs; graph cells are restored here,
  // and only those whose shared values changed are recomputed.
  const restore = () => {
    const query = new URL(globalThis.location.href).searchParams.getAll(sharedInputsParameter).join('\0');
    if (query === previousQuery) return;
    previousQuery = query;
    const current = pageGraphCells(getManifestSnapshot().cells, cell.pagePath);
    for (const candidate of current.length ? current : initial.cells) {
      if (!store.has(candidate.id)) continue;
      const values = store.get(candidate.id).values;
      const restored = restoreSharedInputs(candidate, globalThis.location.href, values);
      if (canonicalSerialize(restored) !== canonicalSerialize(values)) store.setValues(candidate.id, restored, true);
    }
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
