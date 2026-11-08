import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  cacheableResult,
  canonicalSerialize,
  createProducerResultCache,
  resultHash
} from '../../packages/oxiquill/src/lib/doc-runtime/producer-result-cache';
import { normalizeCellExecutionResult } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';
import { validateCellExports } from '../../packages/oxiquill/src/lib/doc-runtime/cell-exports';
import { boundWorkerResult } from '../../packages/oxiquill/src/lib/doc-runtime/worker-output';
import { outputArtifactLimits } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';

export const hash = async (value: unknown) => createHash('sha256').update(canonicalSerialize(value)).digest('hex');
const result = (n = 1) =>
  normalizeCellExecutionResult({
    exports: { value: n },
    outputs: [{ kind: 'text', content: `value ${n}`, stream: 'stdout' }]
  });
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('bounded producer cache', () => {
  it('uses canonical, typed keys and SHA-256', async () => {
    expect(canonicalSerialize({ z: 2, a: { b: true, a: 3 } })).toBe(canonicalSerialize({ a: { a: 3, b: true }, z: 2 }));
    expect(await resultHash({ z: 2, a: 1 })).toBe(await hash({ a: 1, z: 2 }));
    expect(await hash({ a: '1' })).not.toBe(await hash({ a: 1 }));
  });
  it('reuses complete results across configurations and forces replacement', async () => {
    const cache = createProducerResultCache({ hash });
    const run = vi.fn(async () => result());
    const first = await cache.acquire('a', 'one', run, signal());
    await cache.acquire('a', 'two', run, signal());
    expect((await cache.acquire('a', 'one', run, signal())).reused).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    const refreshed = await cache.acquire('a', 'one', async () => result(2), signal(), true);
    expect(refreshed.fingerprint).not.toBe(first.fingerprint);
    expect((await cache.acquire('a', 'one', run, signal())).result).toEqual(result(2));
  });
  it('coalesces subscribers and cancels only when the last one detaches', async () => {
    const cache = createProducerResultCache({ hash });
    const task = deferred<ReturnType<typeof result>>();
    let computationSignal: AbortSignal | undefined;
    const run = vi.fn((signal: AbortSignal) => {
      computationSignal = signal;
      return task.promise;
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.acquire('a', 'key', run, a.signal);
    const second = cache.acquire('a', 'key', run, b.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    a.abort();
    await rejected;
    expect(computationSignal?.aborted).toBe(false);
    task.resolve(result());
    await expect(second).resolves.toMatchObject({ reused: false, result: result() });
    expect(run).toHaveBeenCalledTimes(1);
    const pending = deferred<ReturnType<typeof result>>();
    const c = new AbortController();
    const third = cache.acquire(
      'a',
      'other',
      (signal) => {
        computationSignal = signal;
        return pending.promise;
      },
      c.signal
    );
    const cancelled = expect(third).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    c.abort();
    await cancelled;
    expect(computationSignal?.aborted).toBe(true);
    pending.resolve(result());
  });
  it.each(['timeout', 'failed'])('does not cache %s or replace a valid entry on failed refresh', async (message) => {
    const cache = createProducerResultCache({ hash });
    await cache.acquire('a', 'key', async () => result(), signal());
    const fail = vi.fn(async () => {
      throw new Error(message);
    });
    await expect(cache.acquire('a', 'key', fail, signal(), true)).rejects.toThrow(message);
    expect((await cache.acquire('a', 'key', fail, signal())).reused).toBe(true);
    await expect(cache.acquire('b', 'key', fail, signal())).rejects.toThrow(message);
    await expect(cache.acquire('b', 'key', fail, signal())).rejects.toThrow(message);
    expect(fail).toHaveBeenCalledTimes(3);
  });
  it('evicts the least recently used producer entries at four configurations', async () => {
    const cache = createProducerResultCache({ hash });
    const run = vi.fn(async () => result());
    for (const key of ['1', '2', '3', '4']) await cache.acquire('a', key, run, signal());
    await cache.acquire('a', '1', run, signal());
    await cache.acquire('a', '5', run, signal());
    expect(cache.size).toBe(4);
    expect((await cache.acquire('a', '1', run, signal())).reused).toBe(true);
    expect((await cache.acquire('a', '2', run, signal())).reused).toBe(false);
  });
  it('evicts across producers within the page byte budget and clears selectively', async () => {
    const size = new TextEncoder().encode(canonicalSerialize(result())).length;
    const cache = createProducerResultCache({ hash, maxBytes: size * 2 });
    const run = async () => result();
    await cache.acquire('a', '1', run, signal());
    await cache.acquire('b', '1', run, signal());
    await cache.acquire('a', '1', run, signal());
    await cache.acquire('c', '1', run, signal());
    expect(cache.byteLength).toBe(size * 2);
    expect((await cache.acquire('a', '1', run, signal())).reused).toBe(true);
    expect((await cache.acquire('b', '1', run, signal())).reused).toBe(false);
    cache.clearProducer('b');
    expect(cache.size).toBe(1);
    cache.dispose();
    expect(cache.size).toBe(0);
    expect(cache.byteLength).toBe(0);
    await expect(cache.acquire('a', '1', run, signal())).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('never caches truncated, invalid, or exportless results', async () => {
    for (const candidate of [
      normalizeCellExecutionResult({ outputs: [] }),
      normalizeCellExecutionResult({
        exports: { value: 1 },
        outputs: [{ kind: 'text', content: 'partial', stream: 'stdout', truncated: true }]
      }),
      normalizeCellExecutionResult({
        exports: { value: 1 },
        outputs: [{ kind: '__oxiquill_error', message: 'rejected' }]
      })
    ]) {
      expect(cacheableResult(candidate)).toBe(false);
      const cache = createProducerResultCache({ hash });
      const run = vi.fn(async () => candidate);
      await cache.acquire('a', '1', run, signal());
      await cache.acquire('a', '1', run, signal());
      expect(run).toHaveBeenCalledTimes(2);
    }
  });
  it('prevents old computations from replacing a forced refresh', async () => {
    const cache = createProducerResultCache({ hash });
    const task = deferred<ReturnType<typeof result>>();
    const old = cache.acquire('a', '1', () => task.promise, signal());
    await cache.acquire('a', '1', async () => result(2), signal(), true);
    task.resolve(result());
    await old;
    expect((await cache.acquire('a', '1', async () => result(3), signal())).result).toEqual(result(2));
  });
  it('rejects already obsolete subscribers and drops invalidated in-flight entries', async () => {
    const cache = createProducerResultCache({ hash });
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(async () => result());
    await expect(cache.acquire('a', '1', run, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(run).not.toHaveBeenCalled();
    const task = deferred<ReturnType<typeof result>>();
    const pending = cache.acquire('a', '1', () => task.promise, signal());
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    cache.clearProducer('a');
    task.resolve(result());
    await rejected;
    expect(cache.size).toBe(0);
  });
});

describe('export channel', () => {
  it('retains and freezes finite JSON independently of rendered artifacts', () => {
    const exports = { points: [1, null, true, '日本語'], model: { mean: 2 } };
    const bounded = boundWorkerResult({ outputs: [], exports });
    expect(bounded).toEqual({ outputs: [], exports });
    const normalized = normalizeCellExecutionResult(bounded, { title: 'Generate', exports: ['points', 'model'] });
    expect(normalized.outputs).toEqual([]);
    expect(Object.isFrozen(normalized.exports?.points)).toBe(true);
    expect(Object.isFrozen(normalized.exports?.model)).toBe(true);
  });
  it.each([NaN, Infinity, -Infinity, undefined, () => 1])('rejects non-JSON export data %s', (value) => {
    expect(() => validateCellExports({ nested: { value } })).toThrow('finite JSON');
  });
  it('rejects missing, undeclared, cyclic, accessor, oversized, and non-object exports', () => {
    expect(() => validateCellExports(undefined, { title: 'Generate', exports: ['points'] })).toThrow(
      'Generate: missing export points'
    );
    expect(() => validateCellExports({}, { title: 'Generate', exports: ['points'] })).toThrow('missing export points');
    expect(() => validateCellExports({ points: 1 }, { title: 'Generate' })).toThrow('undeclared export points');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateCellExports(cyclic)).toThrow('finite JSON');
    expect(() =>
      validateCellExports(
        Object.defineProperty({}, 'getter', {
          get() {
            throw new Error('accessed');
          },
          enumerable: true
        })
      )
    ).toThrow('plain JSON');
    expect(() => validateCellExports({ value: 'x'.repeat(outputArtifactLimits.exportBytesPerRun) })).toThrow(
      'exceeded'
    );
    for (const value of [null, 1, []]) expect(() => validateCellExports(value)).toThrow('JSON object');
    expect(validateCellExports(undefined)).toBeUndefined();
  });
});
