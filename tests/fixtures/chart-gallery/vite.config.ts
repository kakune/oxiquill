import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export default defineConfig({
  plugins: process.env.CHART_BASE_REV
    ? [
        {
          name: 'chart-baseline',
          load(id) {
            if (id.endsWith('/components/doc-runtime/ChartOutput.tsx')) {
              return execFileSync(
                'git',
                ['show', `${process.env.CHART_BASE_REV}:packages/oxiquill/src/components/doc-runtime/ChartOutput.tsx`],
                { encoding: 'utf8' }
              );
            }
          }
        }
      ]
    : [],
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: { echarts: fileURLToPath(new URL('../../../packages/oxiquill/node_modules/echarts', import.meta.url)) }
  },
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  optimizeDeps: { rolldownOptions: { transform: { jsx: { runtime: 'automatic', importSource: 'preact' } } } },
  server: { port: 4323, strictPort: true }
});
