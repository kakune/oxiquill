import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));

export function chartGalleryConfig(baseDirectory = process.env.CHART_BASE_DIR) {
  const source = resolve(baseDirectory || repository, 'packages/oxiquill/src');
  if (!existsSync(source)) throw new Error(`Chart gallery source does not exist: ${source}`);
  return defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    resolve: {
      alias: {
        '@chart-source': source,
        echarts: resolve(repository, 'packages/oxiquill/node_modules/echarts'),
        'preact/jsx-dev-runtime': fileURLToPath(import.meta.resolve('preact/jsx-dev-runtime')),
        'preact/jsx-runtime': fileURLToPath(import.meta.resolve('preact/jsx-runtime')),
        'preact/hooks': fileURLToPath(import.meta.resolve('preact/hooks')),
        preact: fileURLToPath(import.meta.resolve('preact'))
      },
      dedupe: ['preact', 'echarts']
    },
    oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
    optimizeDeps: { rolldownOptions: { transform: { jsx: { runtime: 'automatic', importSource: 'preact' } } } },
    server: { port: 4323, strictPort: true, fs: { allow: [repository, source] } }
  });
}

export default chartGalleryConfig();
