// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessRunner } from '../../packages/oxiquill/src/generator/doc-runtime/process-runner.mjs';
import {
  createRuntimeEvents,
  summarizePhases
} from '../../packages/oxiquill/src/generator/doc-runtime/runtime-events.mjs';
import {
  actionReasons,
  changedSources,
  sourceFingerprints,
  pageSourceFingerprints
} from '../../packages/oxiquill/src/generator/doc-runtime/plan-reasons.mjs';
import { artifactBuildFingerprint } from '../../packages/oxiquill/src/generator/doc-runtime/build-inputs.mjs';
import { createEventReporter } from '../../packages/oxiquill/src/cli/events.mjs';

afterEach(() => vi.useRealTimers());

function processFixture() {
  vi.useFakeTimers();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const output = [];
  const events = createRuntimeEvents({ report: (event) => output.push(event) });
  const stdout = { write: vi.fn() };
  const stderr = { write: vi.fn() };
  const spawnProcess = vi.fn(() => child);
  const run = createProcessRunner({ spawnProcess, stdout, stderr, now: () => Date.now() });
  return { child, events, output, stdout, stderr, spawnProcess, run };
}

describe('runtime process reporting', () => {
  it('keeps legacy inherited stdio and launcher-exit behavior outside reporting commands', async () => {
    const fixture = processFixture();
    const promise = fixture.run('astro', ['preview', '--background']);
    expect(fixture.spawnProcess.mock.calls[0][2].stdio).toBe('inherit');
    fixture.child.emit('exit', 0, null);
    await expect(promise).resolves.toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for silence, repeats heartbeats, and stops on process exit', async () => {
    const fixture = processFixture();
    const promise = fixture.run('cargo', [], { events: fixture.events, language: 'rust', module: 'page-a' });
    await vi.advanceTimersByTimeAsync(29_000);
    fixture.child.stderr.emit('data', Buffer.from('compiling\n'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.output.filter((event) => event.type === 'heartbeat')).toHaveLength(1);
    expect(fixture.stderr.write).toHaveBeenCalledWith(Buffer.from('compiling\n'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fixture.output.filter((event) => event.type === 'heartbeat')).toHaveLength(2);
    fixture.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fixture.output.filter((event) => event.type === 'heartbeat')).toHaveLength(2);
    fixture.child.emit('close', 0, null);
    await promise;
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['failure', 'spawn-error', 'cancel'])('stops heartbeat timers after %s', async (kind) => {
    const fixture = processFixture();
    const controller = new AbortController();
    const promise = fixture.run('compiler', [], { events: fixture.events, signal: controller.signal });
    const rejection = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_000);
    if (kind === 'spawn-error') fixture.child.emit('error', new Error('ENOENT'));
    else {
      if (kind === 'cancel') controller.abort();
      fixture.child.emit('close', kind === 'failure' ? 7 : null, kind === 'cancel' ? 'SIGTERM' : null);
    }
    await rejection;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fixture.output.filter((event) => event.type === 'heartbeat')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wraps split UTF-8, CRLF and unterminated output, including output after exit', async () => {
    const fixture = processFixture();
    const promise = fixture.run('cargo', [], { events: fixture.events, format: 'json', captureOutput: true });
    const bytes = Buffer.from('日本語\r\nlast');
    fixture.child.stdout.emit('data', bytes.subarray(0, 2));
    fixture.child.emit('exit', 0, null);
    fixture.child.stdout.emit('data', bytes.subarray(2));
    fixture.child.stderr.emit('data', Buffer.from('warning'));
    fixture.child.emit('close', 0, null);
    await expect(promise).resolves.toBe('日本語\r\nlast');
    expect(fixture.output).toEqual([
      { type: 'output', source: 'cargo', stream: 'stdout', line: '日本語' },
      { type: 'output', source: 'cargo', stream: 'stdout', line: 'last' },
      { type: 'output', source: 'cargo', stream: 'stderr', line: 'warning' }
    ]);
    expect(fixture.stdout.write).not.toHaveBeenCalled();
    expect(fixture.stderr.write).not.toHaveBeenCalled();
  });

  it('preserves child exit codes and actionable diagnostics', async () => {
    const fixture = processFixture();
    const promise = fixture.run('compiler', [], { captureOutput: true });
    fixture.child.stdout.emit('data', Buffer.from('package-id'));
    fixture.child.stderr.emit('data', Buffer.from('invalid source'));
    fixture.child.emit('close', 23, null);
    await expect(promise).rejects.toMatchObject({
      exitCode: 23,
      stdout: 'package-id',
      message: 'compiler exited with 23: invalid source'
    });
  });

  it('tracks detached children and supports successful termination signals', async () => {
    const fixture = processFixture();
    const trackChild = vi.fn();
    const promise = fixture.run('compiler', [], { trackChild, successfulSignals: ['SIGTERM'] });
    expect(trackChild).toHaveBeenCalledWith(fixture.child, process.platform !== 'win32');
    fixture.child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toBe('');
  });
});

describe('phase and plan reporting', () => {
  it('marks active work failed on cancellation without duplicate completion events', async () => {
    const output = [];
    let finish;
    let time = 10;
    const events = createRuntimeEvents({ now: () => time, report: (event) => output.push(event) });
    const work = events.phase(
      'compile',
      { language: 'rust' },
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    time = 50;
    events.failActive();
    finish();
    await work;
    expect(output.map((event) => event.state)).toEqual(['start', 'failure']);
    expect(events.phases).toEqual([expect.objectContaining({ reason: 'cancelled', elapsedMs: 40 })]);
  });
  it('records successful, failed and skipped work using an injected clock', async () => {
    let time = 10;
    const output = [];
    const events = createRuntimeEvents({ now: () => time, report: (event) => output.push(event) });
    await expect(
      events.phase('compile', { language: 'rust' }, async () => {
        time = 25;
        return 42;
      })
    ).resolves.toBe(42);
    await expect(
      events.phase('publish', {}, async () => {
        time = 30;
        throw new Error('failed');
      })
    ).rejects.toThrow('failed');
    events.skipped('optimize', { cache: 'hit' });
    expect(events.phases.map(({ state, elapsedMs }) => [state, elapsedMs])).toEqual([
      ['success', 15],
      ['failure', 5],
      ['skipped', 0]
    ]);
    expect(output.filter((event) => event.state === 'start')).toHaveLength(2);
  });

  it('summarizes nested and concurrent phases by wall-clock time', async () => {
    let time = 0;
    const events = createRuntimeEvents({ now: () => time });
    const gate = (at) => new Promise((resolve) => setTimeout(() => resolve((time = at)), 0));
    await events.phase('generation', {}, async () => {
      await events.phase('generation', { language: 'rust' }, () => gate(10));
      await gate(20);
    });
    // Two modules optimized concurrently from 20 to 50 and from 30 to 40.
    let finishFirst;
    const first = events.phase('optimize', { module: 'a' }, () => new Promise((resolve) => (finishFirst = resolve)));
    time = 30;
    await events.phase('optimize', { module: 'b' }, () => gate(40));
    time = 50;
    finishFirst();
    await first;
    events.skipped('optimize', { cache: 'hit' });
    const summary = Object.fromEntries(summarizePhases(events.phases).map((entry) => [entry.phase, entry]));
    expect(summary.generation.elapsedMs).toBe(20);
    expect(summary.optimize).toMatchObject({ elapsedMs: 30, cache: { hits: 1, misses: 0 } });
    expect(Object.keys(events.phases[0])).not.toContain('interval');
  });

  it('attributes changed, added and removed cell sources without storing source text', () => {
    const before = sourceFingerprints([
      { id: 'a', pagePath: 'a.mdx', source: 'secret-source' },
      { id: 'removed', pagePath: 'b.mdx', source: 'old' }
    ]);
    const after = sourceFingerprints([
      { id: 'a', pagePath: 'a.mdx', source: 'changed' },
      { id: 'new', pagePath: 'c.mdx', source: 'new' }
    ]);
    expect(changedSources(before, after)).toEqual([
      { page: 'a.mdx', cell: 'a' },
      { page: 'c.mdx', cell: 'new' },
      { page: 'b.mdx', cell: 'removed' }
    ]);
    expect(JSON.stringify(before)).not.toContain('secret-source');
  });

  it('stores deterministic page source fingerprints alongside cell fingerprints', () => {
    const before = sourceFingerprints([
      { id: 'a', pagePath: 'first.mdx', source: 'one' },
      { id: 'b', pagePath: 'second.mdx', source: 'two' }
    ]);
    const after = sourceFingerprints([
      { id: 'b', pagePath: 'second.mdx', source: 'two' },
      { id: 'a', pagePath: 'first.mdx', source: 'changed' }
    ]);
    expect(pageSourceFingerprints(before)['second.mdx']).toBe(pageSourceFingerprints(after)['second.mdx']);
    expect(pageSourceFingerprints(before)['first.mdx']).not.toBe(pageSourceFingerprints(after)['first.mdx']);
    expect(pageSourceFingerprints(before)).toEqual(
      pageSourceFingerprints(Object.fromEntries(Object.entries(before).reverse()))
    );
  });

  it('reports every invalidation category and only changed option names', () => {
    const before = {
      generatorIdentity: 'old',
      package: 'old',
      rustBuildInputs: 'old',
      helpers: 'old',
      source: 'old',
      toolchain: 'old'
    };
    const after = Object.fromEntries(Object.keys(before).map((key) => [key, 'new']));
    const reasons = actionReasons({
      action: 'build',
      desired: {
        cellCount: 1,
        sourceFingerprint: 'new',
        buildFingerprint: JSON.stringify(after),
        buildOptions: { RUSTFLAGS: 'digest-new' }
      },
      previous: {
        sourceFingerprint: 'old',
        buildFingerprint: artifactBuildFingerprint(JSON.stringify(before), 'dev'),
        buildOptions: { RUSTFLAGS: 'digest-old' },
        mode: 'dev',
        status: 'failed'
      },
      kind: 'public',
      mode: 'build',
      forced: true,
      complete: false,
      missing: true
    });
    expect(reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'source-changed',
        'forced',
        'output-missing',
        'previous-build-failed',
        'mode-upgrade',
        'helper-inputs-changed',
        'toolchain-changed',
        'generator-changed',
        'package-changed',
        'build-options-changed'
      ])
    );
    expect(reasons.find((reason) => reason.code === 'build-options-changed').variables).toEqual(['RUSTFLAGS']);
    expect(JSON.stringify(reasons)).not.toContain('digest');
    expect(
      actionReasons({ action: 'build', desired: { cellCount: 1 }, kind: 'public', complete: false, missing: false })
    ).toContainEqual({ code: 'integrity-mismatch' });
    expect(actionReasons({ action: 'keep', desired: { cellCount: 1 } })).toEqual([{ code: 'cache-hit' }]);
    expect(actionReasons({ action: 'keep', desired: { cellCount: 0 } })).toEqual([{ code: 'absent' }]);
  });

  it('renders each event as NDJSON and human output without estimates', () => {
    const events = [
      {
        type: 'phase',
        phase: 'compile',
        language: 'rust',
        module: 'page-a',
        state: 'success',
        elapsedMs: 10,
        cache: 'miss'
      },
      {
        type: 'plan',
        language: 'rust',
        action: 'build',
        reasons: [
          { code: 'source-changed', changes: [{ page: 'a.mdx', cell: 'one' }] },
          { code: 'build-options-changed', variables: ['RUSTFLAGS'] }
        ]
      },
      { type: 'heartbeat', phase: 'compile', language: 'rust', module: 'page-a', elapsedMs: 30_000 },
      { type: 'diagnostic', message: 'message' },
      { type: 'summary', phases: [], exitStatus: 0 }
    ];
    const json = [];
    events.forEach(createEventReporter({ format: 'json', write: (line) => json.push(line) }));
    expect(json.map((line) => JSON.parse(line))).toEqual(events);
    const human = [];
    events.forEach(createEventReporter({ write: (line) => human.push(line) }));
    expect(human.join('\n')).toContain('a.mdx (one)');
    expect(human.join('\n')).toContain('still running compile');
    expect(human.join('\n')).not.toMatch(/%|estimate|remaining/iu);
  });
});
