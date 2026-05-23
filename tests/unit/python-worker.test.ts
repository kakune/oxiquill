import { describe, expect, it } from 'vitest';
import {
  createPythonCellResult,
  createSerialRequestQueue,
  pythonDisplaySupportCode
} from '../../src/lib/doc-runtime/python-worker';

function createDeferred() {
  let reject!: (reason: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('python worker request queue', () => {
  it('processes queued requests one at a time', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    expect(events).toEqual(['start:first']);

    first.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
  });

  it('continues draining after a request rejects', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    first.reject(new Error('failed'));
    await first.promise.catch(() => undefined);
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second', 'finish:second']);
  });
});

describe('python rich display support', () => {
  it('exposes display helpers in the injected support module', () => {
    expect(pythonDisplaySupportCode).toContain('builtins.display = display');
    expect(pythonDisplaySupportCode).toContain('def display_table');
    expect(pythonDisplaySupportCode).toContain('_repr_html_');
    expect(pythonDisplaySupportCode).toContain('_repr_png_');
  });

  it('configures matplotlib and captures figures as image artifacts', () => {
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_collect_matplotlib_outputs');
    expect(pythonDisplaySupportCode).toContain('matplotlib.use("Agg", force=True)');
    expect(pythonDisplaySupportCode).toContain('fig.savefig(buffer, format="svg"');
    expect(pythonDisplaySupportCode).toContain('plt.close("all")');
    expect(pythonDisplaySupportCode).toContain('__oxiquill_displayed_figures.add(id(fig))');
  });

  it('combines stream output, rich display artifacts, and final values deterministically', () => {
    expect(createPythonCellResult({
      stdout: 'printed',
      stderr: 'warned',
      value: { ok: true },
      plots: [],
      displayOutputs: [
        { kind: 'html', html: '<strong>display</strong>', sandboxed: true },
        { kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' },
        { kind: 'text', stream: 'display', content: 'fallback' }
      ]
    })).toEqual({
      stdout: 'printed',
      stderr: 'warned',
      value: { ok: true },
      plots: [],
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'printed' },
        { kind: 'text', stream: 'stderr', content: 'warned' },
        { kind: 'html', html: '<strong>display</strong>', sandboxed: true },
        { kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' },
        { kind: 'text', stream: 'display', content: 'fallback' },
        { kind: 'json', value: { ok: true } }
      ]
    });
  });
});
