import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/unit/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx,mjs}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'scripts/doc-runtime-core.mjs',
        'scripts/doc-runtime-service.mjs',
        'scripts/doc-runtime-watch-core.mjs',
        'src/components/doc-runtime/**/*.tsx',
        'src/lib/doc-runtime/**/*.ts',
        'src/lib/doc-runtime/**/*.mjs'
      ],
      exclude: [
        'src/generated/**',
        'src/lib/doc-runtime/manifest.ts',
        'src/lib/doc-runtime/python-worker.ts',
        'src/lib/doc-runtime/rust-worker.ts',
        'src/lib/doc-runtime/types.ts'
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
});
