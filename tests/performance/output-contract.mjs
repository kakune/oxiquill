import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const runtime = path.resolve(argument('--runtime', 'packages/oxiquill/dist/lib/doc-runtime'));
const destination = argument('--output', 'test-results/output-contract.json');
const { normalizeCellExecutionResult } = await import(pathToFileURL(path.join(runtime, 'output-artifacts.js')));
const { boundWorkerResult, workerResultByteLength } = await import(
  pathToFileURL(path.join(runtime, 'worker-output.js'))
);
const fixtures = {
  text: [{ kind: 'text', stream: 'stdout', content: 'x'.repeat(256 * 1024) }],
  json: [{ kind: 'json', value: Array.from({ length: 5000 }, (_, index) => ({ index, value: index / 10 })) }],
  line: [
    {
      kind: 'chart',
      spec: {
        kind: 'line',
        series: [{ points: Array.from({ length: 100000 }, (_, index) => [index, Math.sin(index)]) }]
      }
    }
  ],
  mixed: [
    { kind: 'text', stream: 'stdout', content: 'Printed output' },
    { kind: 'text', stream: 'stderr', content: 'Diagnostic output' },
    { kind: 'json', value: { ok: true } },
    {
      kind: 'chart',
      spec: {
        kind: 'line',
        series: [
          {
            points: [
              [0, 1],
              [1, 2]
            ]
          }
        ]
      }
    }
  ]
};
const measurements = Object.fromEntries(
  Object.entries(fixtures).map(([name, outputs]) => {
    const result = boundWorkerResult({ outputs });
    for (let index = 0; index < 5; index++) normalizeCellExecutionResult(result);
    const samples = Array.from({ length: 25 }, () => {
      const start = performance.now();
      normalizeCellExecutionResult(result);
      return performance.now() - start;
    });
    const normalized = normalizeCellExecutionResult(result);
    return [
      name,
      {
        bytes: workerResultByteLength(result),
        outputCount: normalized.outputs.length,
        errors: normalized.outputResults.filter((output) => output.status === 'error').length,
        medianMs: [...samples].sort((left, right) => left - right)[12],
        samplesMs: samples
      }
    ];
  })
);
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(
  destination,
  JSON.stringify(
    {
      revision: argument('--revision', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
      label: argument('--label', 'measurement'),
      node: process.version,
      cpu: os.cpus()[0].model,
      platform: `${os.platform()} ${os.arch()}`,
      warmups: 5,
      samples: 25,
      measurements
    },
    null,
    2
  ) + '\n'
);
console.log(`Output contract measurements written to ${destination}`);
