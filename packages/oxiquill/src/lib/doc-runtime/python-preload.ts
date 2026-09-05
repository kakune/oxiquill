import type { preparePythonRuntime } from './runtime-client.js';

export function installPythonPreloader(
  page: Document,
  loadRuntime: () => Promise<{ preparePythonRuntime: typeof preparePythonRuntime }>
): () => void {
  let firstCell: Element | null = null;
  let disposed = false;
  const prepare = () => {
    const cell = page.querySelector('.doc-cell[data-language="python"]');
    if (!cell || cell === firstCell) return;
    firstCell = cell;
    let packages: unknown;
    try {
      packages = JSON.parse(cell.getAttribute('data-python-packages') ?? '[]');
    } catch {
      return;
    }
    const timeout = Number(cell.getAttribute('data-python-timeout'));
    if (!Array.isArray(packages) || !packages.every((name): name is string => typeof name === 'string')) return;
    void loadRuntime()
      .then((runtime) => {
        if (!disposed) return runtime.preparePythonRuntime(packages, timeout > 0 ? timeout : undefined);
      })
      .catch(() => {
        // A later cell run retries through the shared runtime's recovery path.
      });
  };
  if (page.readyState === 'loading') page.addEventListener('DOMContentLoaded', prepare, { once: true });
  else prepare();
  page.addEventListener('astro:page-load', prepare);
  return () => {
    disposed = true;
    page.removeEventListener('DOMContentLoaded', prepare);
    page.removeEventListener('astro:page-load', prepare);
  };
}

if (typeof document !== 'undefined') {
  installPythonPreloader(document, () => import('./runtime-client.js'));
}
