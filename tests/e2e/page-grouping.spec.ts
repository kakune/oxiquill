import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { RustRuntimeRegistry } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const root = 'http://127.0.0.1:4325/grouped/';

test('generated page groups fetch only the active page module under a base', async ({ page }) => {
  const manifest = JSON.parse(
    await readFile(new URL('../fixtures/page-grouping/.oxiquill/generated/cells.json', import.meta.url), 'utf8')
  ) as { rust: RustRuntimeRegistry };
  expect(manifest.rust.modules).toHaveLength(3);
  for (const name of ['first', 'second']) {
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    await page.goto(`${root}${name}/`, { waitUntil: 'networkidle' });
    const assets = () => requests.filter((url) => url.includes('/rust-wasm/'));
    expect(assets()).toEqual([]);
    const cell = page.getByTestId(`cell-${name}__compute`);
    await cell.scrollIntoViewIfNeeded();
    await cell.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(cell.locator('.doc-cell__output-region')).toContainText(name === 'first' ? '1' : '5');
    await expect.poll(() => assets().length).toBe(2);
    const descriptor = manifest.rust.modules.find((module) => module.cells.includes(`${name}__compute`));
    expect(descriptor).toBeDefined();
    expect(assets().every((url) => url.startsWith(`/grouped/oxiquill/rust-wasm/${descriptor?.id}-`))).toBe(true);
  }
});

test('text-only pages fetch no generated Rust modules', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto(root, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Grouped Rust', exact: true })).toBeVisible();
  expect(requests.filter((url) => url.includes('/rust-wasm/') || url.includes('/rust-worker-'))).toEqual([]);
});
