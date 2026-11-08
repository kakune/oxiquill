import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPageCellStore } from '../../packages/oxiquill/src/lib/doc-runtime/page-cell-store';
import { canonicalSerialize } from '../../packages/oxiquill/src/lib/doc-runtime/producer-result-cache';
import { normalizeCellExecutionResult } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';
import { dependencyOrder } from '../../packages/oxiquill/src/lib/doc-runtime/cell-graph.mjs';
import type {
  CellManifest,
  InputValues,
  JsonObject,
  RustRuntimeRegistry
} from '../../packages/oxiquill/src/lib/doc-runtime/types';
import type { runInteractiveCell } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-client';

const hash = async (value: unknown) => createHash('sha256').update(canonicalSerialize(value)).digest('hex');
const cell = (id: string, overrides: Partial<CellManifest> = {}): CellManifest => ({
  id,
  pagePath: 'data.mdx',
  title: id,
  language: 'rust',
  run: 'button',
  source: id,
  sourceHtml: '',
  inputs: [],
  crates: [],
  packages: [],
  timeoutMs: 1000,
  showSource: true,
  editable: false,
  ...overrides
});
const numeric = (name: string, value = 1) => ({ name, type: 'integer' as const, value, label: name, options: [] });
const a = cell('a', { exports: ['value'], inputs: [numeric('seed')], producerFingerprint: 'source-a' });
const b = cell('b', { exports: ['value'], dependsOn: { data: { cell: 'a' } } });
const c = cell('c', { dependsOn: { data: { cell: 'b' } }, inputs: [numeric('bias', 0)] });
const registry = (fingerprint = 'module', ids = ['a', 'b', 'c', 'd', 'e']): RustRuntimeRegistry => ({
  version: 1,
  modules: [
    {
      id: 'module',
      fingerprint,
      cells: ids,
      glue: { url: '/glue' },
      wasm: { url: '/wasm', integrity: 'sha256-x', bytes: 1 }
    }
  ]
});
const result = (value: number, producer = true) =>
  normalizeCellExecutionResult({
    outputs: [{ kind: 'text', stream: 'stdout', content: String(value) }],
    ...(producer ? { exports: { value } } : {})
  });
const calculate = (node: CellManifest, inputs: InputValues, dependencies: Readonly<Record<string, JsonObject>> = {}) =>
  result(
    Number(inputs.seed ?? 0) +
      Number(inputs.bias ?? 0) +
      Object.values(dependencies).reduce((sum, data) => sum + Number(data.value), 0) +
      1,
    Boolean(node.exports)
  );
const execute = () =>
  vi.fn<typeof runInteractiveCell>(async (node, inputs, _version, _signal, _phase, _override, _module, deps) =>
    calculate(node, inputs, deps)
  );
const defaults = (node: Pick<CellManifest, 'inputs'>) =>
  Object.fromEntries(node.inputs.map((input) => [input.name, input.value]));
const stores: ReturnType<typeof createPageCellStore>[] = [];
function setup(cells = [a, b, c], run = execute()) {
  const store = createPageCellStore({ cells, rust: registry() }, { execute: run, hash, restore: defaults });
  stores.push(store);
  return { store, run };
}
async function complete(store: ReturnType<typeof createPageCellStore>, id: string) {
  await vi.waitFor(() => expect(['success', 'error']).toContain(store.get(id).status));
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.dispose());
  vi.useRealTimers();
});

describe('page-local graph execution', () => {
  it('runs a complete chain in order regardless of the first requested cell', async () => {
    for (const first of ['a', 'b', 'c']) {
      const { store, run } = setup();
      store.run(first);
      await complete(store, first);
      store.run('c');
      await complete(store, 'c');
      expect(store.get('c').result?.outputs[0]).toMatchObject({ content: '4' });
      expect(store.get('a').result?.exports).toEqual({ value: 2 });
      expect(run.mock.calls.slice(-3).map(([node]) => node.id)).toEqual(['a', 'b', 'c']);
    }
  });
  it('runs the shared ancestor only once in a diamond', async () => {
    const d = cell('d', { exports: ['value'], dependsOn: { data: { cell: 'a' } } });
    const e = cell('e', { dependsOn: { left: { cell: 'b' }, right: { cell: 'd' } } });
    const { store, run } = setup([a, b, d, e]);
    store.run('e');
    await complete(store, 'e');
    expect(run.mock.calls.map(([node]) => node.id)).toEqual(['a', 'b', 'd', 'e']);
    expect(store.get('e').result?.outputs[0]).toMatchObject({ content: '7' });
  });
  it('publishes the graph atomically after offscreen producers finish', async () => {
    let finish: (() => void) | undefined;
    const run = execute().mockImplementation(async (node, inputs, _v, _signal, _p, _o, _m, deps) => {
      if (node.id === 'c')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return calculate(node, inputs, deps);
    });
    const { store } = setup([a, b, c], run);
    store.run('c');
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(store.get('a').result).toBeUndefined();
    expect(store.get('b').result).toBeUndefined();
    finish?.();
    await complete(store, 'c');
    expect(store.get('a').result).toBeDefined();
    store.start('a');
    expect(run).toHaveBeenCalledTimes(3);
  });
  it('suppresses an obsolete downstream completion and publishes only the latest snapshot', async () => {
    let finish: (() => void) | undefined;
    let first = true;
    const run = execute().mockImplementation(async (node, inputs, _v, _signal, _p, _o, _m, deps) => {
      if (node.id === 'c' && first) {
        first = false;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }
      return calculate(node, inputs, deps);
    });
    const { store } = setup([a, b, { ...c, run: 'reactive' }], run);
    store.run('c');
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.setValues('a', { seed: 10 });
    finish?.();
    await complete(store, 'c');
    expect(store.get('c').result?.outputs[0]).toMatchObject({ content: '13' });
    expect(store.get('a').result?.exports).toEqual({ value: 11 });
  });
  it('updates reactive descendants through button intermediates and marks other button descendants stale', async () => {
    const d = cell('d', { dependsOn: { data: { cell: 'a' } } });
    const { store, run } = setup([a, b, { ...c, run: 'reactive' }, d]);
    store.run('d');
    await complete(store, 'd');
    store.run('c');
    await complete(store, 'c');
    run.mockClear();
    store.setValues('a', { seed: 3 });
    await complete(store, 'c');
    expect(run.mock.calls.map(([node]) => node.id)).toEqual(['a', 'b', 'c']);
    expect(store.get('d')).toMatchObject({ status: 'idle', stale: true, upstreamChanged: true });
  });
  it.each(['failure', 'timed out', 'cancelled'])(
    'blocks descendants after producer %s without falling back to old exports',
    async (message) => {
      const { store, run } = setup();
      store.run('c');
      await complete(store, 'c');
      run.mockClear().mockRejectedValue(new Error(message));
      store.run('c');
      await complete(store, 'c');
      expect(run).toHaveBeenCalledTimes(1);
      expect(store.get('c')).toMatchObject({
        status: 'error',
        stale: true,
        upstreamFailure: { id: 'a', title: 'a', diagnostic: message }
      });
    }
  );
  it('treats rejected producer exports as failures', async () => {
    // The runtime client validates exports against the producer declaration.
    const run = execute().mockImplementation(async (node) => normalizeCellExecutionResult({ outputs: [] }, node));
    const { store } = setup([a, b, c], run);
    store.run('c');
    await complete(store, 'c');
    expect(store.get('c').upstreamFailure?.diagnostic).toContain('missing export value');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('keeps inputs valid, applies complete replacements, and resets defaults', async () => {
    const { store, run } = setup();
    store.setValidity('a', 'seed', false);
    store.run('a');
    expect(run).not.toHaveBeenCalled();
    store.run('c');
    await complete(store, 'c');
    expect(store.get('c').upstreamFailure?.diagnostic).toContain('invalid inputs');
    store.setValidity('a', 'seed', false);
    store.setValidity('a', 'seed', true);
    store.setValues('a', { seed: 5 }, true);
    await complete(store, 'a');
    expect(store.get('a').inputRevision).toBe(1);
    store.reset('a');
    await complete(store, 'a');
    expect(store.get('a').values.seed).toBe(1);
  });
  it('clears abandoned upstream running states when a downstream input becomes invalid', async () => {
    let finish: (() => void) | undefined;
    const run = execute().mockImplementation(async (node, inputs, _v, _signal, _p, _o, _m, deps) => {
      if (node.id === 'a')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return calculate(node, inputs, deps);
    });
    const { store } = setup([a, b, c], run);
    store.run('c');
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.setValidity('c', 'bias', false);
    expect(store.get('a').status).toBe('idle');
    expect(store.get('b').status).toBe('idle');
    finish?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.get('a').result).toBeUndefined();
  });
  it('initializes restored inputs for producers before any component subscribes', async () => {
    const run = execute();
    const store = createPageCellStore(
      { cells: [a, b, c], rust: registry() },
      { execute: run, hash, restore: (node) => (node.id === 'a' ? { seed: 7 } : defaults(node)) }
    );
    stores.push(store);
    store.run('c');
    await complete(store, 'c');
    expect(store.get('c').result?.outputs[0]).toMatchObject({ content: '10' });
  });
  it('runs reactive and autorun cells once on first subscription and unsubscribes cleanly', async () => {
    for (const mode of ['reactive', 'autorun'] as const) {
      const { store, run } = setup([{ ...a, run: mode }]);
      const listener = vi.fn();
      const unsubscribe = store.subscribe(listener);
      store.start('a');
      store.start('a');
      await complete(store, 'a');
      expect(run).toHaveBeenCalledTimes(1);
      unsubscribe();
      listener.mockClear();
      store.run('a');
      await complete(store, 'a');
      expect(listener).not.toHaveBeenCalled();
    }
  });
  it('throws useful errors for invalid runtime graphs', () => {
    expect(() => dependencyOrder([a], ['absent'])).toThrow('Unknown dependency');
    expect(() => dependencyOrder([{ ...a, dependsOn: { self: { cell: 'a' } } }], ['a'])).toThrow('Cyclic');
    expect(() => setup().store.get('absent')).toThrow('Unknown cell');
  });
});

describe('page producer caching', () => {
  it('reuses upstream producers for downstream-only controls and earlier configurations', async () => {
    const { store, run } = setup([
      { ...a, cache: 'inputs' },
      { ...b, cache: 'inputs' },
      { ...c, run: 'reactive' }
    ]);
    store.run('c');
    await complete(store, 'c');
    run.mockClear();
    store.setValues('c', { bias: 5 });
    await complete(store, 'c');
    expect(run.mock.calls.map(([node]) => node.id)).toEqual(['c']);
    expect(store.get('a').reused).toBe(true);
    expect(store.get('b').reused).toBe(true);
    store.setValues('a', { seed: 2 });
    await complete(store, 'c');
    store.setValues('a', { seed: 1 });
    await complete(store, 'c');
    expect(store.get('a').reused).toBe(true);
  });
  it('forces only the selected producer on Recompute or button Run', async () => {
    const { store, run } = setup([
      { ...a, cache: 'inputs' },
      { ...b, cache: 'inputs' },
      { ...c, run: 'reactive' }
    ]);
    store.run('c');
    await complete(store, 'c');
    run.mockClear();
    store.run('b', true);
    await complete(store, 'c');
    expect(run.mock.calls.map(([node]) => node.id)).toEqual(['b', 'c']);
    expect(store.get('a').reused).toBe(true);
    expect(store.get('b').reused).toBe(false);
    run.mockClear();
    store.run('a');
    await complete(store, 'c');
    expect(run.mock.calls.map(([node]) => node.id)).toEqual(['a', 'c']);
  });
  it('shares a cached producer between concurrent consumers without cancellation on an unrelated edit', async () => {
    let finish: (() => void) | undefined;
    const d = cell('d', { dependsOn: { data: { cell: 'a' } } });
    const run = execute().mockImplementation(async (node, inputs, _v, signal, _p, _o, _m, deps) => {
      if (node.id === 'a')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      expect(signal?.aborted).toBe(false);
      return calculate(node, inputs, deps);
    });
    const { store } = setup(
      [{ ...a, cache: 'inputs' }, { ...c, dependsOn: { data: { cell: 'a' } }, run: 'reactive' }, d],
      run
    );
    store.run('c');
    store.run('d');
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.setValues('c', { bias: 5 });
    finish?.();
    await complete(store, 'd');
    await complete(store, 'c');
    expect(run.mock.calls.filter(([node]) => node.id === 'a')).toHaveLength(1);
    expect(store.get('c').result?.outputs[0]).toMatchObject({ content: '8' });
  });
  it('invalidates source, definitions identity, and module changes while retaining unrelated modules', async () => {
    const other = cell('d', { exports: ['value'], cache: 'inputs', producerFingerprint: 'other' });
    const cells = [{ ...a, cache: 'inputs' as const }, { ...b, cache: 'inputs' as const }, c, other];
    const modules: RustRuntimeRegistry = {
      version: 1,
      modules: [...registry('one', ['a', 'b', 'c']).modules, { ...registry('two', ['d']).modules[0], id: 'other' }]
    };
    const { store, run } = setup(cells);
    store.reconcile({ cells, rust: modules });
    store.run('c');
    await complete(store, 'c');
    store.run('d');
    await complete(store, 'd');
    for (const changed of [
      { ...cells[0], source: 'new', producerFingerprint: 'new' },
      { ...cells[0], producerFingerprint: 'changed-definitions' }
    ]) {
      run.mockClear();
      store.reconcile({ cells: [changed, ...cells.slice(1)], rust: modules });
      store.run('c');
      await complete(store, 'c');
      // The changed producer recomputes; identical exports keep b's entry valid.
      expect(run.mock.calls.map(([node]) => node.id)).toEqual(['a', 'c']);
      expect(store.get('b').reused).toBe(true);
    }
    store.reconcile({
      cells,
      rust: { version: 1, modules: [{ ...modules.modules[0], fingerprint: 'rebuilt' }, modules.modules[1]] }
    });
    store.run('c');
    await complete(store, 'c');
    // Use a reactive-mode d to read its cache without a button-mode forced run.
    store.reconcile({
      cells: [...cells.slice(0, 3), { ...other, run: 'reactive' }],
      rust: { version: 1, modules: [{ ...modules.modules[0], fingerprint: 'rebuilt' }, modules.modules[1]] }
    });
    store.run('d');
    await complete(store, 'd');
    expect(store.get('d').reused).toBe(true);
  });
  it('installs a complete HMR graph before rerunning consumers of offscreen producers', async () => {
    const { store } = setup([
      { ...a, cache: 'inputs' },
      { ...c, dependsOn: { data: { cell: 'a' } }, run: 'reactive' }
    ]);
    store.start('c');
    await complete(store, 'c');
    const replacement = cell('replacement', { exports: ['value'], inputs: [numeric('seed', 8)] });
    store.reconcile({
      cells: [{ ...c, dependsOn: { data: { cell: 'replacement' } }, run: 'reactive' }, replacement],
      rust: registry('new-module', ['c', 'replacement'])
    });
    await complete(store, 'c');
    expect(store.get('c').result?.outputs[0]).toMatchObject({ content: '10' });
    store.reconcile({
      cells: [
        { ...c, dependsOn: { data: { cell: 'replacement' } }, run: 'reactive' },
        { ...replacement, source: 'changed' }
      ],
      rust: registry('newer-module', ['c', 'replacement'])
    });
    await complete(store, 'c');
    expect(store.get('replacement').status).toBe('success');
  });
  it('reconciles input schemas, additions, removals, and producer cache opt-out', async () => {
    const { store } = setup([{ ...a, cache: 'inputs', run: 'reactive' }]);
    store.start('a');
    await complete(store, 'a');
    store.reconcile({ cells: [{ ...a, inputs: [numeric('new', 3)], run: 'reactive' }, b], rust: registry() });
    await complete(store, 'a');
    expect(store.get('a').values).toEqual({ new: 3 });
    expect(store.get('b').values).toEqual({});
    store.reconcile({ cells: [a], rust: registry() });
    expect(() => store.get('b')).toThrow('Unknown cell');
    store.dispose();
    store.run('a');
  });
});

describe('page graph scheduling', () => {
  const producer = cell('p', { exports: ['value'], inputs: [numeric('seed')], run: 'reactive' });
  const consumer = (id: string, run: CellManifest['run'] = 'reactive') =>
    cell(id, { dependsOn: { data: { cell: 'p' } }, inputs: [numeric('bias', 0)], run });
  const content = (store: ReturnType<typeof createPageCellStore>, id: string) =>
    (store.get(id).result?.outputs[0] as { content?: string } | undefined)?.content;

  it('keeps scheduling after HMR removes a consumer that a producer request still names', async () => {
    const { store } = setup([producer, consumer('x')]);
    store.start('p');
    store.start('x');
    await complete(store, 'x');
    store.setValues('p', { seed: 2 });
    store.reconcile({ cells: [producer], rust: registry() });
    await vi.waitFor(() => expect(content(store, 'p')).toBe('3'));
    expect(() => store.setValues('p', { seed: 3 })).not.toThrow();
    await vi.waitFor(() => expect(content(store, 'p')).toBe('4'));
    expect(store.get('p').status).toBe('success');
  });
  it('restarts sibling consumers when one consumer becomes invalid during propagation', async () => {
    const { store } = setup([producer, consumer('c1'), consumer('c2')]);
    for (const id of ['p', 'c1', 'c2']) store.start(id);
    await complete(store, 'c1');
    await complete(store, 'c2');
    store.setValues('p', { seed: 5 });
    store.setValidity('c1', 'bias', false);
    await vi.waitFor(() => expect(content(store, 'c2')).toBe('7'));
    expect(store.get('c1')).toMatchObject({ status: 'idle', stale: true, upstreamChanged: true, error: undefined });
  });
  it('refreshes autorun consumers when their producer changes', async () => {
    const { store } = setup([producer, consumer('auto', 'autorun')]);
    store.start('p');
    store.start('auto');
    await complete(store, 'auto');
    store.setValues('p', { seed: 4 });
    await vi.waitFor(() => expect(content(store, 'auto')).toBe('6'));
    expect(store.get('auto')).toMatchObject({ stale: false, upstreamChanged: false });
  });
  it('computes a shared producer once for consumers that start together', async () => {
    const { store, run } = setup([{ ...producer, run: 'button' }, consumer('c1'), consumer('c2'), consumer('c3')]);
    for (const id of ['c1', 'c2', 'c3']) store.start(id);
    for (const id of ['c1', 'c2', 'c3']) await complete(store, id);
    expect(run.mock.calls.filter(([node]) => node.id === 'p')).toHaveLength(1);
  });
  it('keeps prerequisites current while a downstream input recomputes', async () => {
    const { store } = setup([producer, consumer('c')]);
    store.start('p');
    store.start('c');
    await complete(store, 'c');
    const states: string[] = [];
    store.subscribe(() => states.push(`${store.get('p').status}:${store.get('p').stale}`));
    store.setValues('c', { bias: 3 });
    await vi.waitFor(() => expect(content(store, 'c')).toBe('6'));
    expect(new Set(states)).toEqual(new Set(['success:false']));
  });
  it('does not report upstream changes to cells that have no result yet', async () => {
    const { store } = setup([producer, consumer('b', 'button')]);
    store.start('p');
    await complete(store, 'p');
    store.setValues('p', { seed: 3 });
    await vi.waitFor(() => expect(content(store, 'p')).toBe('4'));
    expect(store.get('b')).toMatchObject({ stale: false, status: 'idle' });
    expect(store.get('b').upstreamChanged).toBeFalsy();
  });
  it('lets an in-flight computation finish when only the cache setting changes', async () => {
    let finish: (() => void) | undefined;
    const run = execute().mockImplementation(async (node, inputs, _v, _signal, _p, _o, _m, deps) => {
      if (node.id === 'p' && !finish)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return calculate(node, inputs, deps);
    });
    const cached = { ...producer, run: 'button' as const, cache: 'inputs' as const };
    const { store } = setup([cached, consumer('c', 'button')], run);
    store.run('c');
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.reconcile({ cells: [{ ...cached, cache: undefined }, consumer('c', 'button')], rust: registry() });
    finish?.();
    await complete(store, 'c');
    expect(store.get('c')).toMatchObject({ status: 'success', upstreamFailure: undefined });
  });
});
