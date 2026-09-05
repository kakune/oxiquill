import { describe, expect, it, vi } from 'vitest';
import { installPythonPreloader } from '../../packages/oxiquill/src/lib/doc-runtime/python-preload';

function page(html: string, readyState = 'complete') {
  const document = globalThis.document.implementation.createHTMLDocument();
  document.body.innerHTML = html;
  Object.defineProperty(document, 'readyState', { value: readyState });
  return document;
}
const cell =
  '<section class="doc-cell" data-language="python" data-python-packages=\'["numpy"]\' data-python-timeout="60000"></section>';

describe('Python page preparation', () => {
  it('waits for DOM readiness and prepares just the first Python cell without any source', async () => {
    const document = page(cell + cell.replace('numpy', 'pandas'), 'loading');
    const preparePythonRuntime = vi.fn();
    const load = vi.fn(async () => ({ preparePythonRuntime }));
    const dispose = installPythonPreloader(document, load);
    expect(load).not.toHaveBeenCalled();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await Promise.resolve();
    expect(preparePythonRuntime).toHaveBeenCalledExactlyOnceWith(['numpy'], 60_000);
    document.dispatchEvent(new Event('astro:page-load'));
    expect(load).toHaveBeenCalledOnce();
    document.body.innerHTML = cell.replace('numpy', 'pandas');
    document.dispatchEvent(new Event('astro:page-load'));
    await Promise.resolve();
    expect(preparePythonRuntime).toHaveBeenLastCalledWith(['pandas'], 60_000);
    dispose();
    document.body.innerHTML = cell;
    document.dispatchEvent(new Event('astro:page-load'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    '',
    '<section class="doc-cell" data-language="rust"></section>',
    cell.replace('["numpy"]', 'invalid'),
    cell.replace('["numpy"]', '[1]')
  ])('does not load a runtime for missing or invalid Python metadata: %s', (html) => {
    const load = vi.fn();
    installPythonPreloader(page(html), load)();
    expect(load).not.toHaveBeenCalled();
  });

  it('uses default packages/timeouts and contains background failures', async () => {
    const preparePythonRuntime = vi.fn().mockRejectedValue(new Error('unavailable'));
    const dispose = installPythonPreloader(
      page('<section class="doc-cell" data-language="python"></section>'),
      async () => ({ preparePythonRuntime })
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(preparePythonRuntime).toHaveBeenCalledWith([], undefined);
    dispose();
  });

  it('does not start preparation if disposed during module loading', async () => {
    const preparePythonRuntime = vi.fn();
    const dispose = installPythonPreloader(page(cell), async () => ({ preparePythonRuntime }));
    dispose();
    await Promise.resolve();
    expect(preparePythonRuntime).not.toHaveBeenCalled();
    const load = vi.fn();
    const loading = page(cell, 'loading');
    installPythonPreloader(loading, load)();
    loading.dispatchEvent(new Event('DOMContentLoaded'));
    expect(load).not.toHaveBeenCalled();
  });
});
