// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { expect, it } from 'vitest';
import { chartGalleryConfig } from '../fixtures/chart-gallery/vite.config';

it('loads the baseline component, transitive helpers, and CSS from one source tree', async () => {
  const base = await mkdtemp(join(tmpdir(), 'oxiquill-chart-base-'));
  const source = join(base, 'packages/oxiquill/src');
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    for (const directory of ['components/doc-runtime', 'lib/doc-runtime', 'styles']) {
      await mkdir(join(source, directory), { recursive: true });
    }
    await writeFile(
      join(source, 'components/doc-runtime/ChartOutput.tsx'),
      "export { baseline } from '../../lib/doc-runtime/chart-format.js'; export const element = <span>base</span>;"
    );
    await writeFile(join(source, 'lib/doc-runtime/chart-format.ts'), "export const baseline = 'base helper';");
    await writeFile(join(source, 'styles/custom.css'), '.doc-chart-output { color: rgb(1, 2, 3); }');
    const config = chartGalleryConfig(base);
    server = await createServer({
      ...config,
      configFile: false,
      server: { ...config.server, middlewareMode: true, watch: null, hmr: false }
    });
    const component = await server.ssrLoadModule('@chart-source/components/doc-runtime/ChartOutput.tsx');
    expect(component.baseline).toBe('base helper');
    expect(component.element.type).toBe('span');
    const css = await server.environments.client.pluginContainer.resolveId('@chart-source/styles/custom.css');
    expect(css?.id).toBe(join(source, 'styles/custom.css'));
    if (!css) throw new Error('Baseline CSS did not resolve');
    expect(await readFile(css.id, 'utf8')).toContain('rgb(1, 2, 3)');
    const preact = await server.environments.client.pluginContainer.resolveId('preact');
    expect(preact?.id).not.toContain(base);
    expect(() => chartGalleryConfig(join(base, 'missing'))).toThrow('Chart gallery source does not exist');
  } finally {
    await server?.close();
    await rm(base, { recursive: true, force: true });
  }
});
