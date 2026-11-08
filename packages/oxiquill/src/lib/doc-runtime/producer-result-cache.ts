import { ExecutionCancellationError } from './execution-cancellation.js';
import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import { sha256 } from './sha256.js';
import type { NormalizedCellExecutionResult } from './output-artifacts.js';

export function canonicalSerialize(value: unknown): string {
  return JSON.stringify(value, (_name, candidate: unknown) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : candidate
  );
}

export async function resultHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalSerialize(value));
  // `crypto.subtle` exists only in secure contexts; the fallback yields the same digest.
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle ? new Uint8Array(await subtle.digest('SHA-256', bytes)) : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cacheableResult(result: NormalizedCellExecutionResult): boolean {
  return (
    result.exports !== undefined &&
    result.outputResults.every(
      (output) => output.status === 'valid' && !('truncated' in output.artifact && output.artifact.truncated)
    )
  );
}

/**
 * `fingerprint` identifies the exports that descendants read; results without
 * exports have none. Output-only differences do not change it.
 */
export type ProducerResult = { result: NormalizedCellExecutionResult; fingerprint?: string; reused: boolean };
type Entry = ProducerResult & { bytes: number; producer: string; used: number };
type Flight = { controller: AbortController; subscribers: number; promise: Promise<ProducerResult> };
export type AcquireOptions = {
  /** Starts a new computation instead of reusing a stored entry or an in-flight computation. */
  force?: boolean;
  /** Keeps a cacheable result for later requests (`cache: inputs`); otherwise only in-flight work is shared. */
  store?: boolean;
};

export function createProducerResultCache({
  maxBytes = outputArtifactLimits.cachedResultBytesPerPage,
  maxEntries = 4,
  hash = resultHash
}: { maxBytes?: number; maxEntries?: number; hash?: typeof resultHash } = {}) {
  const entries = new Map<string, Entry>();
  const flights = new Map<string, Flight>();
  let bytes = 0;
  let clock = 0;
  let disposed = false;
  const remove = (key: string) => {
    const entry = entries.get(key);
    if (entry) bytes -= entry.bytes;
    entries.delete(key);
  };
  const evict = (producer: string) => {
    const oldest = (candidates: readonly [string, Entry][]) =>
      [...candidates].sort(([, a], [, b]) => a.used - b.used)[0];
    let own = [...entries].filter(([, entry]) => entry.producer === producer);
    while (own.length > maxEntries) {
      remove(oldest(own)[0]);
      own = [...entries].filter(([, entry]) => entry.producer === producer);
    }
    while (bytes > maxBytes && entries.size) remove(oldest([...entries])[0]);
  };
  function acquire(
    producer: string,
    key: string,
    execute: (signal: AbortSignal) => Promise<NormalizedCellExecutionResult>,
    signal: AbortSignal,
    { force = false, store = true }: AcquireOptions = {}
  ): Promise<ProducerResult> {
    if (disposed || signal.aborted) return Promise.reject(new ExecutionCancellationError());
    const identity = canonicalSerialize([producer, key]);
    const entry = store ? entries.get(identity) : undefined;
    if (entry && !force) {
      entry.used = ++clock;
      return Promise.resolve({ result: entry.result, fingerprint: entry.fingerprint, reused: true });
    }
    let flight = force ? undefined : flights.get(identity);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const attempt: Flight = { controller, subscribers: 0, promise: Promise.resolve(undefined as never) };
      attempt.promise = Promise.resolve()
        .then(async () => {
          if (controller.signal.aborted) throw new ExecutionCancellationError();
          const result = await execute(controller.signal);
          if (controller.signal.aborted) throw new ExecutionCancellationError();
          const fingerprint = result.exports === undefined ? undefined : await hash(result.exports);
          if (controller.signal.aborted) throw new ExecutionCancellationError();
          const completed = { result, fingerprint, reused: false };
          // A detached flight (see clearProducer) still answers its subscribers but is never stored.
          if (store && !disposed && flights.get(identity) === attempt && cacheableResult(result)) {
            remove(identity);
            const size = utf8ByteLength(JSON.stringify(result));
            entries.set(identity, { ...completed, producer, bytes: size, used: ++clock });
            bytes += size;
            evict(producer);
          }
          return completed;
        })
        .finally(() => {
          if (flights.get(identity) === attempt) flights.delete(identity);
        });
      flights.set(identity, attempt);
      flight = attempt;
    }
    const shared = flight;
    shared.subscribers += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        shared.subscribers -= 1;
        if (shared.subscribers === 0) shared.controller.abort();
        callback();
      };
      const abort = () => finish(() => reject(new ExecutionCancellationError()));
      signal.addEventListener('abort', abort, { once: true });
      void shared.promise.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error))
      );
      if (signal.aborted) abort();
    });
  }
  /**
   * Forgets a producer's stored results and detaches its in-flight computations:
   * current subscribers still receive them, later requests start afresh, and
   * detached results are never stored.
   */
  function clearProducer(producer: string): void {
    for (const [key, entry] of entries) if (entry.producer === producer) remove(key);
    for (const key of [...flights.keys()]) if ((JSON.parse(key) as string[])[0] === producer) flights.delete(key);
  }
  function dispose(): void {
    disposed = true;
    entries.clear();
    bytes = 0;
    for (const flight of flights.values()) flight.controller.abort();
    flights.clear();
  }
  return {
    acquire,
    clearProducer,
    dispose,
    get byteLength() {
      return bytes;
    },
    get size() {
      return entries.size;
    }
  };
}
