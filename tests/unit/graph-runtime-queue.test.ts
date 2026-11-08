import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInteractiveCellRunner } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-client';
import type {
  CellManifest,
  RuntimeWorkerRequest,
  RustRuntimeModule
} from '../../packages/oxiquill/src/lib/doc-runtime/types';

const module: RustRuntimeModule = {
  id: 'module',
  fingerprint: 'v1',
  cells: ['a', 'b', 'c'],
  glue: { url: '/glue' },
  wasm: { url: '/wasm', integrity: 'sha256-x', bytes: 1 }
};
const cell = (id: string): CellManifest => ({
  id,
  pagePath: 'data.mdx',
  title: id,
  language: 'rust',
  run: 'button',
  source: '',
  sourceHtml: '',
  inputs: [],
  crates: [],
  packages: [],
  timeoutMs: 10,
  editable: false,
  showSource: true
});
class FakeWorker extends EventTarget {
  messages: RuntimeWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: RuntimeWorkerRequest) {
    if ('cellId' in message) this.messages.push(message);
  }
  reply() {
    const request = this.messages.at(-1);
    if (!request) throw new Error('No dispatched request');
    this.dispatchEvent(
      new MessageEvent('message', {
        data: { requestId: request.requestId, rustModule: request.rustModule, ok: true, result: { outputs: [] } }
      })
    );
  }
}
function setup() {
  vi.useFakeTimers();
  const workers: FakeWorker[] = [];
  const runner = createInteractiveCellRunner({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    setTimeout,
    clearTimeout
  });
  const run = (id: string, signal?: AbortSignal) =>
    runner.runInteractiveCell(cell(id), {}, undefined, signal, undefined, undefined, module, {});
  return { runner, workers, run };
}
afterEach(() => vi.useRealTimers());

describe('serialized graph worker dispatch', () => {
  it('starts each node timeout on dispatch and preserves queued work after an active timeout', async () => {
    const { workers, run } = setup();
    const first = run('a');
    const failure = expect(first).rejects.toThrow('a timed out after 10ms');
    const second = run('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    workers[1].reply();
    await expect(second).resolves.toMatchObject({ outputs: [] });
  });
  it('cancels queued work without terminating a computation still in progress', async () => {
    const { workers, run } = setup();
    const first = run('a');
    const controller = new AbortController();
    const queued = run('b', controller.signal);
    const cancelled = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await cancelled;
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers[0].messages).toHaveLength(1);
  });
  it('terminates an active cancelled computation and dispatches unaffected queued work on a new worker', async () => {
    const { workers, run } = setup();
    const controller = new AbortController();
    const first = run('a', controller.signal);
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = run('b');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await cancelled;
    await vi.advanceTimersByTimeAsync(0);
    expect(workers).toHaveLength(2);
    workers[1].reply();
    await second;
  });
  it('rejects obsolete queued module identities before execution', async () => {
    const { runner, workers, run } = setup();
    runner.updateRustRegistry({ version: 1, modules: [module] });
    const first = run('a');
    const second = run('b');
    const rejected = Promise.all([
      expect(first).rejects.toThrow('obsolete fingerprint'),
      expect(second).rejects.toThrow('obsolete fingerprint')
    ]);
    await vi.advanceTimersByTimeAsync(0);
    runner.updateRustRegistry({ version: 1, modules: [{ ...module, fingerprint: 'v2' }] });
    await rejected;
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    expect(workers[0].messages).toHaveLength(1);
  });
});
