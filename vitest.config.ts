import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const testFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      'echarts/charts': testFile('./tests/unit/mocks/echarts-modules.ts'),
      'echarts/components': testFile('./tests/unit/mocks/echarts-modules.ts'),
      'echarts/core': testFile('./tests/unit/mocks/echarts-core.ts'),
      'echarts/renderers': testFile('./tests/unit/mocks/echarts-modules.ts'),
      mermaid: testFile('./tests/unit/mocks/mermaid.ts')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx,mjs}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'packages/oxiquill/src/generator/doc-runtime-core.mjs',
        'packages/oxiquill/src/generator/doc-runtime-service.mjs',
        'packages/oxiquill/src/generator/doc-runtime-watch-core.mjs',
        'packages/oxiquill/src/generator/run-helper-cargo.mjs',
        'packages/oxiquill/src/components/doc-runtime/**/*.tsx',
        'packages/oxiquill/src/lib/doc-runtime/**/*.ts',
        'packages/oxiquill/src/lib/doc-runtime/**/*.mjs'
      ],
      exclude: [
        '**/.oxiquill/**',
        'packages/oxiquill/src/lib/doc-runtime/haskell-worker.ts',
        'packages/oxiquill/src/lib/doc-runtime/manifest.ts',
        'packages/oxiquill/src/lib/doc-runtime/python-worker.ts',
        'packages/oxiquill/src/lib/doc-runtime/rust-worker.ts',
        'packages/oxiquill/src/lib/doc-runtime/types.ts'
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85
      }
    }
  }
});
