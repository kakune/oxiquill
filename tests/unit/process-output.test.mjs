// @vitest-environment node

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeProcess } from '../e2e/process-output.mjs';

afterEach(() => vi.useRealTimers());

function processDouble() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null
  });
}

describe('buffered process output', () => {
  it('retains both streams before a waiter is registered', async () => {
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    child.stdout.write('[runtime] rea');
    child.stderr.write('dy: 4 cells\n');
    await expect(process.waitForOutput('[runtime] ready:', 100)).resolves.toBeUndefined();
  });

  it('matches future split chunks and multiple waiters', async () => {
    vi.useFakeTimers();
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    const ready = process.waitForOutput('[runtime] ready:', 100);
    const watching = process.waitForOutput(/^\[runtime\] watching .+$/mu, 100);
    child.stdout.write('[runtime] watching documentation and helper-crate inputs\n[runtime] re');
    child.stdout.write('ady: 4 cells');
    await expect(Promise.all([ready, watching])).resolves.toEqual([undefined, undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not depend on a language list or mutate a regular expression cursor', async () => {
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    const matcher = /^\[runtime\] watching .+$/gmu;
    matcher.lastIndex = 100;
    child.stdout.write('[runtime] watching new language sources\n');
    await process.waitForOutput(matcher, 100);
    await process.waitForOutput(matcher, 100);
    expect(matcher.lastIndex).toBe(100);
  });

  it.each([false, true])('fails promptly on watcher exit (before registration: %s)', async (before) => {
    vi.useFakeTimers();
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    child.stderr.write('compile failed\n');
    if (before) child.emit('exit', 7, null);
    const waiting = process.waitForOutput('ready', 60_000);
    const assertion = expect(waiting).rejects.toThrow('runtime: exited with 7\ncompile failed');
    if (!before) child.emit('exit', 7, null);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an exited process even when its readiness output was buffered', async () => {
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    child.stdout.write('ready');
    child.emit('exit', null, 'SIGTERM');
    await expect(process.waitForOutput('ready', 100)).rejects.toThrow('exited with SIGTERM');
  });

  it.each([false, true])('retains spawn errors (before registration: %s)', async (before) => {
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    if (before) child.emit('error', new Error('ENOENT'));
    const waiting = process.waitForOutput('ready', 100);
    const assertion = expect(waiting).rejects.toThrow('runtime: failed to start: ENOENT');
    if (!before) child.emit('error', new Error('ENOENT'));
    await assertion;
    await expect(process.waitForExit()).rejects.toThrow('ENOENT');
  });

  it('includes startup output and the expected matcher in timeout diagnostics', async () => {
    vi.useFakeTimers();
    const child = processDouble();
    const process = observeProcess(child, 'runtime');
    child.stdout.write('still compiling');
    const waiting = process.waitForOutput(/ready/u, 100);
    const assertion = expect(waiting).rejects.toThrow('runtime: timed out waiting for /ready/u\nstill compiling');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    child.stdout.write('ready');
    await process.waitForOutput('ready', 100);
  });

  it.each([false, true])('observes successful command exits (before registration: %s)', async (before) => {
    const child = processDouble();
    const process = observeProcess(child, 'install');
    if (before) child.emit('exit', 0, null);
    const waiting = process.waitForExit();
    if (!before) child.emit('exit', 0, null);
    await expect(waiting).resolves.toBeUndefined();
  });

  it('reports unsuccessful command exits with their output', async () => {
    const child = processDouble();
    const process = observeProcess(child, 'install');
    child.stderr.write('missing package');
    const waiting = process.waitForExit();
    const assertion = expect(waiting).rejects.toThrow('install: exited with 1\nmissing package');
    child.emit('exit', 1, null);
    await assertion;
  });
});
