import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInteractiveCellRunner,
  resetInteractiveRuntime,
  runtimeHaskellFingerprintHash,
  runInteractiveCell
} from '../../packages/oxiquill/src/lib/doc-runtime/runtime-client';
import { normalizeCellExecutionResult } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';
import { outputArtifactLimits, utf8ByteLength } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';
import type {
  CellExecutionResult,
  CellLanguage,
  CellManifest,
  RuntimeWorkerRequest
} from '../../packages/oxiquill/src/lib/doc-runtime/types';

class FakeWorker {
  addEventListenerFailure: unknown;
  messages: RuntimeWorkerRequest[] = [];
  postMessageFailure: unknown;
  terminated = false;

  private listeners = new Map<string, Set<(event: Event) => void>>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    if (this.addEventListenerFailure !== undefined) throw this.addEventListenerFailure;
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
  }

  postMessage(message: RuntimeWorkerRequest): void {
    if (this.postMessageFailure !== undefined) throw this.postMessageFailure;
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(response: unknown): void {
    this.emit('message', { data: response } as MessageEvent);
  }

  emitError(message: string): void {
    this.emit('error', { message } as ErrorEvent);
  }

  emitMessageError(): void {
    this.emit('messageerror', {} as MessageEvent);
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
const normalizedResult = normalizeCellExecutionResult(result);

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

afterEach(() => {
  vi.useRealTimers();
});

describe('runtime client', () => {
  it('delegates the default browser runner to Worker adapters', async () => {
    const originalWorker = globalThis.Worker;
    const defaultWorkers: DefaultFakeWorker[] = [];
    globalThis.Worker = class extends FakeWorker {
      constructor(
        readonly url: URL,
        readonly options: WorkerOptions
      ) {
        super();
        defaultWorkers.push(this as DefaultFakeWorker);
      }
    } as unknown as typeof Worker;

    const rust = runInteractiveCell(makeCell('rust'), {});
    const python = runInteractiveCell(makeCell('python'), {});
    const haskell = runInteractiveCell(makeCell('haskell'), {});

    expect(defaultWorkers[0].options).toEqual({ type: 'module' });
    expect(defaultWorkers[0].url.href).toContain('rust-worker.ts');
    expect(defaultWorkers[1].url.href).toContain('python-worker.ts');
    expect(defaultWorkers[2].url.href).toContain('haskell-worker.ts');

    defaultWorkers[0].emitMessage({ requestId: 1, ok: true, result });
    defaultWorkers[1].emitMessage({ requestId: 2, ok: true, result });
    defaultWorkers[2].emitMessage({ requestId: 3, ok: true, result });

    await expect(rust).resolves.toEqual(normalizedResult);
    await expect(python).resolves.toEqual(normalizedResult);
    await expect(haskell).resolves.toEqual(normalizedResult);

    resetInteractiveRuntime('rust');
    expect(defaultWorkers[0].terminated).toBe(true);
    expect(defaultWorkers[1].terminated).toBe(false);
    expect(defaultWorkers[2].terminated).toBe(false);

    resetInteractiveRuntime();
    expect(defaultWorkers[1].terminated).toBe(true);
    expect(defaultWorkers[2].terminated).toBe(true);
    globalThis.Worker = originalWorker;
  });

  it('sends Python source and resolves successful worker responses', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(
      makeCell('python', {
        inputs: [{ name: 'scale', type: 'number', label: 'scale', value: 1, options: [] }]
      }),
      { scale: 2 }
    );

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

    await expect(promise).resolves.toEqual(normalizedResult);
  });

  it('marks portable integer inputs for Python int conversion and accepts negative values', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(
      makeCell('python', {
        inputs: [{ name: 'offset', type: 'integer', label: 'offset', value: 0, options: [] }]
      }),
      { offset: -2147483648 }
    );

    expect(workers[0].messages[0]).toMatchObject({
      inputs: { offset: -2147483648 },
      integerInputNames: ['offset']
    });
    workers[0].emitMessage({ requestId: 1, ok: true, result });
    await expect(promise).resolves.toEqual(normalizedResult);
  });

  it.each([-2147483649, 2147483648, Number.MAX_SAFE_INTEGER + 1])(
    'rejects integer values outside the portable domain before creating a worker: %s',
    async (value) => {
      const { runner, workers } = makeRunner();
      const promise = runner.runInteractiveCell(
        makeCell('rust', {
          inputs: [{ name: 'count', type: 'integer', label: 'count', value: 0, options: [] }]
        }),
        { count: value }
      );

      await expect(promise).rejects.toThrow('invalid committed numeric value');
      expect(workers).toEqual([]);
    }
  );

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
      inputArgs: undefined,
      inputs: {},
      source: undefined,
      packages: undefined
    });
    expect(workers[0].messages[1].cellId).toBe('rust-cell-two');

    workers[0].emitMessage({ requestId: 1, ok: true, result });
    workers[0].emitMessage({ requestId: 2, ok: true, result });

    await expect(first).resolves.toEqual(normalizedResult);
    await expect(second).resolves.toEqual(normalizedResult);
  });

  it('sends Haskell input arguments in manifest order', async () => {
    const { runner, workers } = makeRunner();
    const first = runner.runInteractiveCell(
      makeCell('haskell', {
        inputs: [
          { name: 'enabled', type: 'checkbox', label: 'enabled', value: false, options: [] },
          { name: 'scale', type: 'integer', label: 'scale', value: 2, options: [] },
          { name: 'label', type: 'text', label: 'label', value: 'fallback', options: [] }
        ]
      }),
      { enabled: true, scale: 4 },
      '{"haskell":"haskell-hash"}'
    );
    const second = runner.runInteractiveCell(makeCell('haskell', { id: 'haskell-cell-two' }), {});

    expect(workers).toHaveLength(1);
    expect(workers[0].messages[0]).toMatchObject({
      requestId: 1,
      cellId: 'haskell-cell',
      haskellFingerprintHash: 'haskell-hash',
      inputArgs: ['true', '4', 'fallback'],
      source: undefined,
      packages: undefined
    });
    expect(workers[0].messages[1].cellId).toBe('haskell-cell-two');

    workers[0].emitMessage({ requestId: 1, ok: true, result });
    workers[0].emitMessage({ requestId: 2, ok: true, result });

    await expect(first).resolves.toEqual(normalizedResult);
    await expect(second).resolves.toEqual(normalizedResult);
  });

  it('extracts the Haskell fingerprint hash from generated runtime versions', () => {
    expect(runtimeHaskellFingerprintHash('{"haskell":"hash-one","rust":"hash-two"}')).toBe('hash-one');
    expect(runtimeHaskellFingerprintHash('"not-an-object"')).toBeUndefined();
    expect(runtimeHaskellFingerprintHash('not-json')).toBeUndefined();
    expect(runtimeHaskellFingerprintHash(undefined)).toBeUndefined();
  });

  it('rejects failed cell responses without resetting the shared worker', async () => {
    const { runner, workers } = makeRunner();
    const promise = runner.runInteractiveCell(makeCell('python'), {});

    workers[0].emitMessage({ requestId: 1, ok: false, error: 'boom' });

    await expect(promise).rejects.toThrow('boom');
    const next = runner.runInteractiveCell(makeCell('python', { id: 'python-next' }), {});
    expect(workers).toHaveLength(1);
    workers[0].emitMessage({ requestId: 2, ok: true, result });
    await expect(next).resolves.toEqual(normalizedResult);
  });

  it('bounds oversized worker errors and malformed artifact diagnostics', async () => {
    const { runner, workers } = makeRunner();
    const failed = runner.runInteractiveCell(makeCell('python'), {});
    workers[0].emitMessage({
      requestId: 1,
      ok: false,
      error: 'x'.repeat(outputArtifactLimits.bytesPerError + 1)
    });
    const workerError = await failed.catch((error: unknown) => error);
    expect(workerError).toBeInstanceOf(Error);
    expect(utf8ByteLength((workerError as Error).message)).toBeLessThanOrEqual(outputArtifactLimits.bytesPerError);

    const malformed = runner.runInteractiveCell(makeCell('python'), {});
    workers[0].emitMessage({
      requestId: 2,
      ok: true,
      result: { outputs: [{ kind: 'x'.repeat(outputArtifactLimits.bytesPerDiagnostic * 2) }] }
    });
    const normalized = await malformed;
    expect(normalized.outputResults[0]).toMatchObject({ status: 'error' });
    const diagnostic = normalized.outputResults[0];
    if (diagnostic?.status === 'error') {
      expect(utf8ByteLength(diagnostic.message)).toBeLessThanOrEqual(outputArtifactLimits.bytesPerDiagnostic);
    }
  });

  it('rejects every request owned by a timed-out worker and creates a clean replacement', async () => {
    vi.useFakeTimers();
    const workers: FakeWorker[] = [];
    const clearTimer = vi.fn(clearTimeout);
    const runner = createInteractiveCellRunner({
      clearTimeout: clearTimer,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      setTimeout
    });

    runner.resetWorker('rust');
    const timedOut = runner.runInteractiveCell(makeCell('rust', { timeoutMs: 10 }), {});
    const companion = runner.runInteractiveCell(makeCell('rust', { id: 'rust-companion' }), {});
    vi.advanceTimersByTime(10);

    await expect(timedOut).rejects.toThrow('timed out after 10ms');
    await expect(companion).rejects.toThrow('timed out after 10ms');
    expect(workers[0].terminated).toBe(true);
    expect(clearTimer).toHaveBeenCalledTimes(2);

    const next = runner.runInteractiveCell(makeCell('rust'), {});
    expect(workers).toHaveLength(2);
    workers[1].emitMessage({ requestId: 3, ok: true, result });
    await expect(next).resolves.toEqual(normalizedResult);

    const reset = runner.runInteractiveCell(makeCell('rust'), {});
    runner.resetWorker('rust');

    await expect(reset).rejects.toThrow('rust worker was reset');
    expect(workers[1].terminated).toBe(true);
  });

  it('cancels active worker requests, clears their timers, and recovers with a replacement worker', async () => {
    const workers: FakeWorker[] = [];
    const clearTimer = vi.fn(clearTimeout);
    const runner = createInteractiveCellRunner({
      clearTimeout: clearTimer,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      },
      setTimeout
    });
    const controller = new AbortController();
    const cancelled = runner.runInteractiveCell(makeCell('rust'), {}, undefined, controller.signal);
    const companion = runner.runInteractiveCell(makeCell('rust', { id: 'rust-companion' }), {});

    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await expect(companion).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0].terminated).toBe(true);
    expect(clearTimer).toHaveBeenCalledTimes(2);

    const recovered = runner.runInteractiveCell(makeCell('rust'), {});
    expect(workers).toHaveLength(2);
    workers[1].emitMessage({ requestId: 3, ok: true, result });
    await expect(recovered).resolves.toEqual(normalizedResult);
  });

  it('rejects only requests owned by a failed worker and replaces that worker', async () => {
    const { runner, workers } = makeRunner();
    const firstRust = runner.runInteractiveCell(makeCell('rust'), {});
    const secondRust = runner.runInteractiveCell(makeCell('rust', { id: 'rust-second' }), {});
    const python = runner.runInteractiveCell(makeCell('python'), {});

    expect(workers).toHaveLength(2);
    workers[0].emitError('worker failed');

    await expect(firstRust).rejects.toThrow('worker failed');
    await expect(secondRust).rejects.toThrow('worker failed');
    expect(workers[0].terminated).toBe(true);
    workers[1].emitMessage({ requestId: 3, ok: true, result });
    await expect(python).resolves.toEqual(normalizedResult);

    const replacement = runner.runInteractiveCell(makeCell('rust'), {});
    expect(workers).toHaveLength(3);
    workers[2].emitMessage({ requestId: 4, ok: true, result });
    await expect(replacement).resolves.toEqual(normalizedResult);
  });

  it('ignores responses emitted by a worker that does not own the request', async () => {
    const { runner, workers } = makeRunner();
    let settled = false;
    const rust = runner.runInteractiveCell(makeCell('rust'), {}).finally(() => {
      settled = true;
    });
    const python = runner.runInteractiveCell(makeCell('python'), {});

    workers[1].emitMessage({ requestId: 1, ok: true, result });
    await Promise.resolve();
    expect(settled).toBe(false);

    workers[0].emitMessage({ requestId: 1, ok: true, result });
    workers[1].emitMessage({ requestId: 2, ok: true, result });
    await expect(rust).resolves.toEqual(normalizedResult);
    await expect(python).resolves.toEqual(normalizedResult);
  });

  it('replaces workers after message deserialization and synchronous post failures', async () => {
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

    const unreadable = runner.runInteractiveCell(makeCell('haskell'), {});
    workers[0].emitMessageError();
    await expect(unreadable).rejects.toThrow('haskell worker sent an unreadable message');
    expect(workers[0].terminated).toBe(true);

    const failedWorker = new FakeWorker();
    failedWorker.postMessageFailure = 'post failed';
    const postFailureRunner = createInteractiveCellRunner({
      clearTimeout,
      createWorker: () => {
        workers.push(failedWorker);
        return failedWorker as unknown as Worker;
      },
      setTimeout
    });
    const failedPost = postFailureRunner.runInteractiveCell(makeCell('python'), {});

    await expect(failedPost).rejects.toThrow('post failed');
    expect(failedWorker.terminated).toBe(true);
  });

  it('rejects every owned request after a malformed worker response', async () => {
    const { runner, workers } = makeRunner();
    const first = runner.runInteractiveCell(makeCell('python'), {});
    const second = runner.runInteractiveCell(makeCell('python', { id: 'python-second' }), {});

    workers[0].emitMessage({ requestId: 1, ok: 'yes' });

    await expect(first).rejects.toThrow('python worker sent an invalid message');
    await expect(second).rejects.toThrow('python worker sent an invalid message');
    expect(workers[0].terminated).toBe(true);

    const replacement = runner.runInteractiveCell(makeCell('python'), {});
    expect(workers).toHaveLength(2);
    workers[1].emitMessage({ requestId: 3, ok: true, result });
    await expect(replacement).resolves.toEqual(normalizedResult);
  });

  it('terminates workers that fail while registering startup listeners', async () => {
    const worker = new FakeWorker();
    worker.addEventListenerFailure = new Error('listener registration failed');
    const runner = createInteractiveCellRunner({
      clearTimeout,
      createWorker: () => worker as unknown as Worker,
      setTimeout
    });

    await expect(runner.runInteractiveCell(makeCell('haskell'), {})).rejects.toThrow('listener registration failed');
    expect(worker.terminated).toBe(true);
  });

  it('returns worker construction failures as rejected promises', async () => {
    const runner = createInteractiveCellRunner({
      clearTimeout,
      createWorker: () => {
        throw new Error('worker construction failed');
      },
      setTimeout
    });

    await expect(runner.runInteractiveCell(makeCell('rust'), {})).rejects.toThrow('worker construction failed');
  });
});
