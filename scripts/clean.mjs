import { rm } from 'node:fs/promises';

const paths = [
  'dist',
  '.astro',
  'coverage',
  'src/generated/doc-runtime',
  'public/pyodide',
  'playwright-report',
  'test-results'
];

await Promise.all(
  paths.map((path) =>
    rm(path, { recursive: true, force: true })
  )
);
