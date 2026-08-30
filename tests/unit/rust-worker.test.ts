import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import { outputArtifactLimits, utf8ByteLength } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';
import { initializeRustWasm, run_rust_cell } from './mocks/virtual-runtime';

type MessageListener = (event: MessageEvent<RuntimeWorkerRequest>) => void;

const worker = {
  listener: undefined as MessageListener | undefined,
  addEventListener: vi.fn((_type: 'message', listener: MessageListener) => {
    worker.listener = listener;
  }),
  postMessage: vi.fn<(response: RuntimeWorkerResponse) => void>()
};

beforeAll(async () => {
  vi.stubGlobal('self', worker);
  await import('../../packages/oxiquill/src/lib/doc-runtime/rust-worker');
});

beforeEach(() => {
  initializeRustWasm.mockClear();
  run_rust_cell.mockClear();
  worker.postMessage.mockClear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('Rust runtime worker', () => {
  it('initializes Wasm once and posts parsed cell results', async () => {
    run_rust_cell.mockReturnValue(
      JSON.stringify({
        stdout: 'ok',
        plots: [],
        outputs: [{ kind: 'text', stream: 'stdout', content: 'ok' }]
      })
    );

    worker.listener?.({
      data: { requestId: 1, cellId: 'first', inputs: { count: 2 } }
    } as unknown as MessageEvent<RuntimeWorkerRequest>);
    worker.listener?.({
      data: { requestId: 2, cellId: 'second', inputs: {} }
    } as MessageEvent<RuntimeWorkerRequest>);
    await flushMicrotasks();

    expect(initializeRustWasm).toHaveBeenCalledTimes(1);
    expect(run_rust_cell).toHaveBeenNthCalledWith(1, 'first', '{"count":2}');
    expect(worker.postMessage).toHaveBeenCalledWith({
      requestId: 1,
      ok: true,
      result: {
        stdout: 'ok',
        plots: [],
        outputs: [{ kind: 'text', stream: 'stdout', content: 'ok' }]
      }
    });
  });

  it('returns errors from failed executions', async () => {
    run_rust_cell.mockImplementationOnce(() => {
      throw new Error('Rust cell failed');
    });

    worker.listener?.({ data: { requestId: 3, cellId: 'failed', inputs: {} } } as MessageEvent<RuntimeWorkerRequest>);
    await flushMicrotasks();
    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: 3, ok: false, error: 'Rust cell failed' });

    run_rust_cell.mockImplementationOnce(() => {
      throw 'string failure';
    });
    worker.listener?.({
      data: { requestId: 4, cellId: 'failed-again', inputs: {} }
    } as MessageEvent<RuntimeWorkerRequest>);
    await flushMicrotasks();
    expect(worker.postMessage).toHaveBeenCalledWith({ requestId: 4, ok: false, error: 'string failure' });

    run_rust_cell.mockImplementationOnce(() => {
      throw new Error('x'.repeat(outputArtifactLimits.bytesPerError + 1));
    });
    worker.listener?.({
      data: { requestId: 5, cellId: 'oversized-error', inputs: {} }
    } as MessageEvent<RuntimeWorkerRequest>);
    await flushMicrotasks();
    const response = worker.postMessage.mock.calls.at(-1)?.[0];
    expect(response?.ok).toBe(false);
    if (response?.ok === false) {
      expect(utf8ByteLength(response.error)).toBeLessThanOrEqual(outputArtifactLimits.bytesPerError);
    }
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
