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
      mermaid: testFile('./tests/unit/mocks/mermaid.ts'),
      'virtual:oxiquill/cells': testFile('./tests/unit/mocks/virtual-runtime.ts'),
      'virtual:oxiquill/runtime-version': testFile('./tests/unit/mocks/virtual-runtime.ts'),
      'virtual:oxiquill/rust-wasm': testFile('./tests/unit/mocks/virtual-runtime.ts')
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
      include: ['packages/oxiquill/src/**/*.{mjs,ts,tsx}'],
      exclude: ['packages/oxiquill/src/**/*.d.ts', 'packages/oxiquill/src/lib/doc-runtime/types.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85
      }
    }
  }
});
