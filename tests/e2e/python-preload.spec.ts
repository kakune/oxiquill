import { expect, test } from '@playwright/test';

test('prepares first-cell dependencies before visible hydration without running authored code', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 800, height: 240 });
  const workerRequests: unknown[] = [];
  await page.exposeFunction('observePythonRequest', (message: unknown) => workerRequests.push(message));
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
      if (message && typeof message === 'object' && ('source' in message || 'type' in message)) {
        void (
          globalThis as unknown as { observePythonRequest: (message: unknown) => Promise<void> }
        ).observePythonRequest(message);
      }
      return Reflect.apply(post, this, [message, ...rest]);
    };
  });
  await page.goto('/features/rich-output/', { waitUntil: 'networkidle' });
  const cell = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await expect.poll(() => workerRequests.length).toBe(1);
  expect(workerRequests[0]).toMatchObject({ type: 'prepare', packages: ['matplotlib', 'numpy', 'pandas'] });
  expect(workerRequests[0]).not.toHaveProperty('source');
  await expect(cell.locator('.doc-cell__outputs')).toHaveCount(0);
  await cell.scrollIntoViewIfNeeded();
  await expect(cell.locator('.run-button')).toBeVisible();
  await cell.locator('.run-button').click();
  await expect(cell.locator('.doc-cell__outputs')).toBeVisible({ timeout: 90_000 });
  await expect(cell.getByRole('alert')).toHaveCount(0);
  expect(workerRequests.filter((request) => (request as { type?: string }).type === 'prepare')).toHaveLength(1);
  expect(page.workers().filter((worker) => worker.url().includes('python-worker'))).toHaveLength(1);
  const timings = await page
    .workers()
    .find((worker) => worker.url().includes('python-worker'))
    ?.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => ({ name: entry.name, startTime: entry.startTime, end: entry.startTime + entry.duration }))
    );
  const core = timings?.find((entry) => entry.name.endsWith('/pyodide.asm.wasm'));
  const wheels = timings?.filter((entry) => entry.name.endsWith('.whl')) ?? [];
  expect(core).toBeDefined();
  expect(wheels.length).toBeGreaterThan(0);
  expect(wheels.every((entry) => new URL(entry.name).origin === new URL(page.url()).origin)).toBe(true);
  expect(wheels.some((entry) => entry.startTime < (core?.end ?? 0))).toBe(true);
});

test('a failed page preparation recovers when a reader runs the cell', async ({ page }) => {
  test.setTimeout(120_000);
  let failed = false;
  await page.route('**/pyodide/pyodide.mjs', async (route) => {
    if (!failed) {
      failed = true;
      await route.fulfill({ status: 503, body: 'Temporary failure' });
    } else await route.continue();
  });
  await page.goto('/features/rich-output/', { waitUntil: 'networkidle' });
  await expect.poll(() => failed).toBe(true);
  const cell = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await cell.scrollIntoViewIfNeeded();
  await cell.locator('.run-button').click();
  await expect(cell.locator('.doc-cell__outputs')).toBeVisible({ timeout: 90_000 });
  await expect(cell.getByRole('alert')).toHaveCount(0);
});
