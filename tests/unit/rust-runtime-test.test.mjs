// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  executeGeneratedRustCell,
  testGeneratedRustCells,
  testFailures
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-runtime-test.mjs';
import { runRustTestRequest } from '../../packages/oxiquill/src/generator/doc-runtime/rust-test-worker.mjs';
import { runWasmTests } from '../../packages/oxiquill/src/cli/test-wasm.mjs';
import { createEventReporter, boundedDisplay } from '../../packages/oxiquill/src/cli/events.mjs';
import { createGenerationSnapshot } from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';

const paths = createOxiquillPaths({ workspaceRoot: '/fixture' });
const cell = {
  id: 'guide__sample',
  localId: 'sample',
  pagePath: 'content/docs/guide.mdx',
  fenceStartLine: 5,
  language: 'rust',
  inputs: [],
  timeoutMs: 10
};
const test = { cell, page: 'guide.mdx', case: 'default', testIndex: 0, expect: [] };
afterEach(() => vi.useRealTimers());

describe('Rust worker request', () => {
  it('uses browser artifact normalization and bounds malformed producer artifacts', async () => {
    const runtime = {
      run_rust_cell: vi.fn(() => JSON.stringify({ outputs: [{ kind: 'json', value: 42 }, { kind: 'unknown' }] }))
    };
    expect(await runRustTestRequest(runtime, { cellId: cell.id, inputs: { n: 2 } })).toEqual({
      kind: 'result',
      result: { outputs: [{ kind: 'json', value: 42 }] }
    });
    expect(runtime.run_rust_cell).toHaveBeenCalledWith(cell.id, '{"n":2}');
    expect(
      await runRustTestRequest(
        {
          run_rust_cell: () => {
            throw 'author error';
          }
        },
        {}
      )
    ).toEqual({ kind: 'execution-error', error: 'author error' });
    expect(await runRustTestRequest({ run_rust_cell: () => 'invalid JSON' }, {})).toMatchObject({
      kind: 'harness-error'
    });
  });
});

describe('isolated execution adapter', () => {
  const setup = () => {
    vi.useFakeTimers();
    const worker = Object.assign(new EventEmitter(), {
      terminate: vi.fn(async () => 0),
      postMessage: vi.fn(),
      stdout: { resume: vi.fn() },
      stderr: { resume: vi.fn() }
    });
    const createWorker = vi.fn(() => worker);
    const promise = executeGeneratedRustCell({
      module: {},
      runtimeUrl: 'file:///runtime.js',
      cell,
      inputs: { x: 1 },
      createWorker
    });
    return { worker, createWorker, promise };
  };
  it('starts execution after initialization and terminates after completion', async () => {
    const { worker, createWorker, promise } = setup();
    worker.emit('message', { kind: 'ready' });
    expect(worker.postMessage).toHaveBeenCalledWith({ cellId: cell.id, inputs: { x: 1 } });
    worker.emit('message', { kind: 'result', result: { outputs: [] } });
    worker.emit('exit', 1);
    expect(await promise).toEqual({ kind: 'result', result: { outputs: [] } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(createWorker.mock.calls[0][1]).toMatchObject({
      workerData: { module: {}, runtimeUrl: 'file:///runtime.js' },
      stdout: true,
      stderr: true
    });
  });
  it('terminates synchronous executions at the per-cell deadline', async () => {
    const { worker, promise } = setup();
    worker.emit('message', { kind: 'ready' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await promise).toEqual({ kind: 'timeout', error: 'Cell guide__sample timed out after 10ms' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it('bounds initialization separately', async () => {
    const { worker, promise } = setup();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await promise).toMatchObject({
      kind: 'harness-error',
      error: expect.stringContaining('initialization timed out')
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
  it.each(['error', 'exit'])('handles worker %s before a response', async (event) => {
    const { worker, promise } = setup();
    worker.emit(event, event === 'error' ? new Error('worker failed') : 1);
    expect(await promise).toMatchObject({ kind: 'harness-error' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Rust test suite', () => {
  it('compiles once, continues after failures, and emits bounded diagnostics', async () => {
    const compile = vi.fn(async () => 'compiled');
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'result', result: { outputs: [] } })
      .mockResolvedValueOnce({ kind: 'execution-error', error: 'failure' })
      .mockRejectedValueOnce(new Error('worker failed'));
    const report = vi.fn();
    const result = await testGeneratedRustCells({
      tests: [test, test, test],
      paths,
      report,
      compile,
      execute,
      fileSystem: { readFile: vi.fn(async () => 'bytes') }
    });
    expect(result).toEqual({ total: 3, passed: 1, failed: 2 });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenCalledTimes(3);
    expect(report.mock.calls[1][0].failures[0].reason).toBe('execution-error');
    expect(report.mock.calls[2][0].failures[0].reason).toBe('harness-error');
    expect(await testGeneratedRustCells({ tests: [], paths, report })).toEqual({ total: 0, passed: 0, failed: 0 });
  });
  it('reports assertion locations, missing values, and expected errors', () => {
    const asserted = {
      ...test,
      expect: [{ path: '/missing', equals: null }],
      expectationLocations: [{ line: 12, column: 8 }]
    };
    expect(testFailures(asserted, { kind: 'result', result: { outputs: [] } })).toEqual([
      expect.objectContaining({
        reason: 'missing-path',
        fieldPath: 'tests[0].expect[0]',
        actual: '(missing)',
        location: { line: 12, column: 8 }
      })
    ]);
    const errors = { ...test, expect: [{ error: 'expected' }] };
    expect(testFailures(errors, { kind: 'execution-error', error: 'expected error' })).toEqual([]);
    expect(testFailures(errors, { kind: 'timeout', error: 'expected timeout' })[0].reason).toBe('timeout');
    expect(
      testFailures(
        { ...test, expect: [{ artifact: 'summary', path: '', equals: 1 }] },
        { kind: 'result', result: { outputs: [] } }
      )[0]
    ).toMatchObject({ artifact: 'summary', reason: 'missing-artifact' });
  });
});

describe('command orchestration and output', () => {
  const setup = (cells = [cell]) => ({
    projectConfig: { paths },
    values: {},
    log: vi.fn(),
    progress: vi.fn(),
    collect: vi.fn(async () => cells),
    readHelpers: vi.fn(async () => []),
    assertSnapshot: vi.fn(async () => {}),
    generateRuntime: vi.fn(async () => ({
      generationId: createGenerationSnapshot(cells, []).generationId,
      haskellCellCount: 1,
      haskellFingerprint: 'fingerprint'
    })),
    testRust: vi.fn(async () => ({ total: cells.length, passed: cells.length, failed: 0 })),
    testHaskell: vi.fn(async () => ({ cellCount: 1 }))
  });
  it('retains Haskell smoke tests without selectors and skips them with selectors', async () => {
    const options = setup();
    await runWasmTests(options);
    expect(options.testHaskell).toHaveBeenCalledWith({ paths, expectedFingerprint: 'fingerprint' });
    options.values = { case: ['default'] };
    options.testHaskell.mockClear();
    await runWasmTests(options);
    expect(options.testHaskell).not.toHaveBeenCalled();
  });
  it('rejects selectors before generating anything and emits a final JSON summary', async () => {
    const options = { ...setup(), values: { cell: ['absent'], format: 'json' } };
    await expect(runWasmTests(options)).rejects.toThrow('matched no cells');
    expect(options.generateRuntime).not.toHaveBeenCalled();
    expect(options.log.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { type: 'diagnostic', message: expect.stringContaining('matched no cells') },
      { type: 'summary', total: 0, passed: 0, failed: 0, exitStatus: 1 }
    ]);
  });
  it('reports failed suites and Haskell failures as nonzero', async () => {
    const options = setup();
    options.testRust.mockResolvedValue({ total: 1, passed: 0, failed: 1 });
    await expect(runWasmTests(options)).rejects.toThrow('1 Rust cell test(s) failed');
    options.testHaskell.mockRejectedValue(new Error('Haskell failed'));
    await expect(runWasmTests(options)).rejects.toThrow('Haskell failed');
    expect(options.log.mock.calls.at(-1)[0]).toContain('Haskell fail');
  });
  it('rejects source changes and reports compiler failures before the summary', async () => {
    const options = { ...setup(), values: { format: 'json' } };
    options.generateRuntime.mockResolvedValue({ generationId: 'different' });
    await expect(runWasmTests(options)).rejects.toThrow('sources changed');
    options.generateRuntime.mockRejectedValue(new Error('compiler failed'));
    await expect(runWasmTests(options)).rejects.toThrow('compiler failed');
    expect(options.log.mock.calls.at(-1)[0]).toContain('"exitStatus":1');
  });
  it('handles empty sites and wires stderr-only compiler adapters for JSON', async () => {
    const options = { ...setup([]), values: { format: 'json' } };
    options.generateRuntime.mockResolvedValue({
      generationId: createGenerationSnapshot([], []).generationId,
      haskellCellCount: 0
    });
    await runWasmTests(options);
    expect(options.generateRuntime.mock.calls[0][0].runtimeOptions).toEqual({
      buildRust: expect.any(Function),
      buildHaskell: expect.any(Function)
    });
    expect(JSON.parse(options.log.mock.calls.at(-1)[0])).toEqual({
      type: 'summary',
      total: 0,
      passed: 0,
      failed: 0,
      exitStatus: 0
    });
  });
  it('renders human failures and bounded actual values', () => {
    const write = vi.fn();
    const report = createEventReporter({ write });
    report({
      type: 'test',
      status: 'fail',
      page: 'guide.mdx',
      line: 5,
      cell: cell.id,
      case: 'named',
      failures: [
        {
          location: { line: 12, column: 8 },
          path: '/value',
          artifact: 'summary',
          fieldPath: 'tests[0].expect[0]',
          reason: 'not-equal',
          actual: '1',
          expected: '2'
        }
      ]
    });
    expect(write.mock.calls[0][0]).toContain('FAIL guide.mdx:5 guide__sample case=named');
    expect(write.mock.calls[1][0]).toContain('guide.mdx:12:8');
    expect(Buffer.byteLength(boundedDisplay('語'.repeat(1000)))).toBeLessThanOrEqual(1024);
  });
});
