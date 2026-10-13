import { boundWorkerResult, workerResultByteLength } from '@chart-source/lib/doc-runtime/worker-output';

self.onmessage = ({ data: { kind, count, revision } }) => {
  const started = performance.now();
  const points = Array.from({ length: count }, (_, index) => [index, Math.sin(index / 40) + revision / 10]);
  const prepared = performance.now();
  const result = boundWorkerResult({
    outputs: [{ kind: 'chart', spec: { kind, series: [{ points }], style: { animation: false } } }]
  });
  const bounded = performance.now();
  const bytes = workerResultByteLength(result);
  const legacy = { ...result, plots: [result.outputs[0].spec] };
  const legacyBytes = workerResultByteLength(legacy);
  const cloneStarted = performance.now();
  structuredClone(result);
  const cloned = performance.now();
  structuredClone(legacy);
  const legacyCloned = performance.now();
  self.postMessage({
    result,
    bytes,
    legacyBytes,
    preparationMs: prepared - started,
    boundingMs: bounded - prepared,
    cloneMs: cloned - cloneStarted,
    legacyCloneMs: legacyCloned - cloned,
    sentAt: performance.timeOrigin + performance.now()
  });
};
self.postMessage('ready');
