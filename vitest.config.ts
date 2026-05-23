import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/unit/**/*.test.{ts,tsx,mjs}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: [
        'scripts/**/*.mjs',
        'src/components/**/*.tsx',
        'src/lib/**/*.ts',
        'src/lib/**/*.mjs'
      ],
      exclude: ['src/generated/**'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100
      }
    }
  }
});
