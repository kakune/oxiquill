import { describe, expect, it, vi } from 'vitest';
import {
  createRustRuntimeLoader,
  createRustWorkerRequestHandler
} from '../../packages/oxiquill/src/lib/doc-runtime/rust-worker';
import type { RustRuntimeModule } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const moduleA: RustRuntimeModule = {
  id: 'first',
  fingerprint: 'a',
  glue: { url: '/first-a.js' },
  wasm: { url: '/first-a.wasm', integrity: `sha384-${'A'.repeat(64)}`, bytes: 8 },
  cells: ['cell-a']
};
const moduleB: RustRuntimeModule = {
  ...moduleA,
  id: 'second',
  fingerprint: 'b',
  glue: { url: '/second-b.js' },
  wasm: { ...moduleA.wasm, url: '/second-b.wasm' },
  cells: ['cell-b']
};
const result = { outputs: [{ kind: 'text', stream: 'stdout', content: 'ok' }] };
function setup() {
  const glue = {
    default: vi.fn(async (): Promise<void> => undefined),
    run_rust_cell: vi.fn(() => JSON.stringify(result))
  };
  const fetchImpl = vi.fn(async () => new Response(new Uint8Array(8)));
  const importGlue = vi.fn<(url: string) => Promise<typeof glue>>(async () => glue);
  const loader = createRustRuntimeLoader({ fetchImpl, importGlue });
  const postMessage = vi.fn();
  return {
    glue,
    fetchImpl,
    importGlue,
    loader,
    postMessage,
    handle: createRustWorkerRequestHandler({ loader, postMessage })
  };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('Rust module worker', () => {
  it('loads only the requested module, shares initialization, and independently loads a second module', async () => {
    const { loader, fetchImpl, importGlue, glue } = setup();
    expect(fetchImpl).not.toHaveBeenCalled();
    const first = loader.load(moduleA);
    expect(loader.load(moduleA)).toBe(first);
    await first;
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(moduleA.wasm.url, { integrity: moduleA.wasm.integrity });
    expect(importGlue).toHaveBeenCalledExactlyOnceWith(moduleA.glue.url);
    expect(glue.default).toHaveBeenCalledWith({ module_or_path: expect.any(Response) });
    await loader.load(moduleB);
    expect(importGlue.mock.calls.map(([url]) => url)).toEqual([moduleA.glue.url, moduleB.glue.url]);
    expect(loader.load(moduleA)).toBe(first);
  });

  it.each(['network', 'import', 'instantiate', 'http'] as const)(
    'shares %s failures, retries later, and keeps other modules',
    async (failure) => {
      const { loader, fetchImpl, importGlue, glue } = setup();
      const retained = loader.load(moduleB);
      await retained;
      if (failure === 'network') fetchImpl.mockRejectedValueOnce(new Error('integrity mismatch'));
      if (failure === 'import') importGlue.mockRejectedValueOnce(new Error('import failed'));
      if (failure === 'instantiate') glue.default.mockRejectedValueOnce(new Error('instantiate failed'));
      if (failure === 'http') fetchImpl.mockResolvedValueOnce(new Response('', { status: 404 }));
      const first = loader.load(moduleA);
      expect(loader.load(moduleA)).toBe(first);
      await expect(first).rejects.toThrow('Rust module first could not load');
      expect(loader.load(moduleB)).toBe(retained);
      await expect(loader.load(moduleA)).resolves.toBe(glue);
    }
  );

  it('replaces one fingerprint, preserves another, and rejects late initialization without evicting its replacement', async () => {
    const { loader, glue } = setup();
    const readyB = loader.load(moduleB);
    await readyB;
    const waiting = deferred();
    glue.default.mockImplementationOnce(() => waiting.promise);
    const obsolete = loader.load(moduleA);
    await Promise.resolve();
    await Promise.resolve();
    const next = { ...moduleA, fingerprint: 'a2', glue: { url: '/first-a2.js' } };
    loader.update({ version: 1, modules: [next, moduleB] });
    const replacement = loader.load(next);
    await replacement;
    waiting.resolve();
    await expect(obsolete).rejects.toThrow('obsolete');
    expect(loader.load(next)).toBe(replacement);
    expect(loader.load(moduleB)).toBe(readyB);
    await expect(loader.load(moduleA)).rejects.toThrow('obsolete');
    loader.update({ version: 1, modules: [] });
    await expect(loader.load(moduleB)).rejects.toThrow('obsolete');
  });

  it('posts bounded execution results and module identity, and reports execution and descriptor errors', async () => {
    const { handle, postMessage, glue } = setup();
    const request = { requestId: 1, cellId: 'cell-a', inputs: { count: 2 }, rustModule: moduleA };
    await handle(request);
    expect(glue.run_rust_cell).toHaveBeenCalledWith('cell-a', '{"count":2}');
    expect(postMessage).toHaveBeenLastCalledWith({
      requestId: 1,
      rustModule: { id: 'first', fingerprint: 'a' },
      ok: true,
      result
    });
    glue.run_rust_cell.mockImplementationOnce(() => {
      throw Object.create(null);
    });
    await handle(request);
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({ ok: false, error: 'Unknown error.' });
    glue.run_rust_cell.mockReturnValueOnce('invalid JSON');
    await handle(request);
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({ ok: false });
    await handle({ ...request, rustModule: undefined });
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('no matching module')
    });
    await handle({ ...request, cellId: 'other' });
    expect(postMessage.mock.lastCall?.[0]).toMatchObject({
      ok: false,
      error: expect.stringContaining('no matching module')
    });
  });
});
