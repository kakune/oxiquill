import { describe, expect, it, vi } from 'vitest';
import {
  createInteractiveCellRunner,
  resetInteractiveRuntime,
  runInteractiveCell
} from '../../packages/oxiquill/src/lib/doc-runtime/runtime-client';
import type {
  CellExecutionResult,
  CellLanguage,
  CellManifest,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse
} from '../../packages/oxiquill/src/lib/doc-runtime/types';

class FakeWorker {
  messages: RuntimeWorkerRequest[] = [];
  terminated = false;

  private listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
  }

  postMessage(message: RuntimeWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(response: RuntimeWorkerResponse): void {
    this.emit('message', { data: response } as MessageEvent);
  }

  emitError(message: string): void {
    this.emit('error', { message } as ErrorEvent);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const result: CellExecutionResult = {
  stdout: 'ok',
  plots: [],
  outputs: [{ kind: 'text', stream: 'stdout', content: 'ok' }]
};

type DefaultFakeWorker = FakeWorker & {
  options: WorkerOptions;
  url: URL;
};

function makeCell(language: CellLanguage, overrides: Partial<CellManifest> = {}): CellManifest {
  return {
    id: `${language}-cell`,
    language,
    title: `${language} cell`,
    run: 'button',
    source: 'print("ok")',
    sourceHtml: '<pre />',
    inputs: [],
    packages: ['numpy'],
    crates: [],
    timeoutMs: 1_000,
    showSource: true,
    pagePath: 'page.mdx',
    ...overrides
  };
}

function makeRunner() {
  const workers: FakeWorker[] = [];
  const runner = createInteractiveCellRunner({
    clearTimeout,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    setTimeout
  });

  return { runner, workers };
}

describe('runtime client', () => {
  it('delegates the default browser runner to Worker adapters', async () => {
    const originalWorker = globalThis.Worker;
    const defaultWorkers: DefaultFakeWorker[] = [];
    globalThis.Worker = class extends FakeWorker {
      constructor(readonly url: URL, readonly options: WorkerOptions) {
        super();
        defaultWorkers.push(this as DefaultFakeWorker);
      }
    } as unknown as typeof Worker;

    const rust = runInteractiveCell(makeCell('rust'), {});
    const python = runInteractiveCell(makeCell('python'), {});

    expect(defaultWorkers[0].options).toEqual({ type: 'module' });
    expect(defaultWorkers[0].url.href).toContain('rust-worker.ts');
    expect(defaultWorkers[1].url.href).toContain('python-worker.ts');

    defaultWorkers[0].emitMessage({ requestId: 1, ok: true, result });
    defaultWorkers[1].emitMessage({ requestId: 2, ok: true, result });

    await expect(rust).resolves.toEqual(result);
    await expect(python).resolves.toEqual(result);

    resetInteractiveRuntime('rust');
    expect(defaultWorkers[0].terminated).toBe(true);
    expect(defaultWorkers[1].terminated).toBe(false);

    resetInteractiveRuntime();
    expect(defaultWorkers[1].terminated).toBe(true);
    globalThis.Worker = originalWorker;
  });

  it('sends Python source and resolves successful worker responses', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(makeCell('python'), { scale: 2 });

    expect(workers).toHaveLength(1);
    expect(workers[0].messages[0]).toMatchObject({
      requestId: 1,
      cellId: 'python-cell',
      inputs: { scale: 2 },
      source: 'print("ok")',
      packages: ['numpy']
    });

    workers[0].emitMessage({ requestId: 999, ok: true, result });
    workers[0].emitMessage({ requestId: 1, ok: true, result });

    await expect(promise).resolves.toEqual(result);
  });

  it('normalizes legacy worker responses before resolving', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(makeCell('python'), {});

    workers[0].emitMessage({
      requestId: 1,
      ok: true,
      result: {
        stdout: 'legacy stdout',
        value: { answer: 42 },
        plots: [{ kind: 'line', x_label: 'x', y_label: 'y', points: [[0, 1]] }]
      }
    });

    await expect(promise).resolves.toMatchObject({
      stdout: 'legacy stdout',
      value: { answer: 42 },
      plots: [{ kind: 'line', x_label: 'x', y_label: 'y', points: [[0, 1]] }],
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'legacy stdout' },
        { kind: 'json', value: { answer: 42 } },
        {
          kind: 'chart',
          spec: expect.objectContaining({
            kind: 'line',
            xLabel: 'x',
            yLabel: 'y'
          })
        }
      ]
    });
  });

  it('sends Rust requests without Python-only fields and reuses workers', async () => {
    const { runner, workers } = makeRunner();
    const first = runner.runInteractiveCell(makeCell('rust'), {});
    const second = runner.runInteractiveCell(makeCell('rust', { id: 'rust-cell-two' }), {});

    expect(workers).toHaveLength(1);
    expect(workers[0].messages[0]).toEqual({
      requestId: 1,
      cellId: 'rust-cell',
      inputs: {},
      source: undefined,
      packages: undefined
    });
    expect(workers[0].messages[1].cellId).toBe('rust-cell-two');

    workers[0].emitMessage({ requestId: 1, ok: true, result });
    workers[0].emitMessage({ requestId: 2, ok: true, result });

    await expect(first).resolves.toEqual(result);
    await expect(second).resolves.toEqual(result);
  });

  it('rejects failed worker responses', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(makeCell('python'), {});

    workers[0].emitMessage({ requestId: 1, ok: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
  });

  it('resets workers on timeout and explicit reset', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const runner = createInteractiveCellRunner({
      clearTimeout,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      setTimeout
    });

    runner.resetWorker('rust');
    const promise = runner.runInteractiveCell(makeCell('rust', { timeoutMs: 10 }), {});
    vi.advanceTimersByTime(10);

    await expect(promise).rejects.toThrow('timed out after 10ms');
    expect(workers[0].terminated).toBe(true);

    const next = runner.runInteractiveCell(makeCell('rust'), {});
    expect(workers).toHaveLength(2);
    runner.resetWorker('rust');

    await expect(next).rejects.toThrow('rust worker was reset');
    expect(workers[1].terminated).toBe(true);
    vi.useRealTimers();
  });

  it('rejects pending requests when a worker errors', async () => {
    const { runner, workers } = makeRunner();
    const rust = runner.runInteractiveCell(makeCell('rust'), {});
    const python = runner.runInteractiveCell(makeCell('python'), {});

    expect(workers).toHaveLength(2);
    workers[0].emitError('worker failed');

    await expect(rust).rejects.toThrow('worker failed');
    workers[1].emitMessage({ requestId: 2, ok: true, result });
    await expect(python).resolves.toEqual(result);
  });
});
