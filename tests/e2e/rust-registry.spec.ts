import { expect, test } from '@playwright/test';

const fixtureUrl = 'http://127.0.0.1:4324/registry-base/';
test('two registry modules load lazily under a base and replace independently in one worker', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(fixtureUrl, { waitUntil: 'networkidle' });
  const moduleRequests = () => requests.filter((url) => url.includes('/modules/'));
  expect(moduleRequests()).toEqual([]);
  await page.getByRole('button', { name: 'Run first', exact: true }).click();
  await expect(page.locator('#result')).toContainText('kind');
  expect(moduleRequests()).toHaveLength(2);
  expect(moduleRequests().every((url) => url.startsWith('/registry-base/modules/first-'))).toBe(true);
  await page.getByRole('button', { name: 'Run second', exact: true }).click();
  await expect(page.locator('#result')).toContainText('kind');
  expect(moduleRequests()).toHaveLength(4);
  await page.getByRole('button', { name: 'Replace first', exact: true }).click();
  await page.getByRole('button', { name: 'Run second', exact: true }).click();
  await expect(page.locator('#result')).toContainText('kind');
  expect(moduleRequests()).toHaveLength(4);
  await page.getByRole('button', { name: 'Run first', exact: true }).click();
  await expect(page.locator('#result')).toContainText('kind');
  expect(moduleRequests()).toHaveLength(6);
  await expect(page.locator('body')).toHaveAttribute('data-workers', '1');
});

test('integrity failure names the module and the next run retries successfully', async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.getByRole('button', { name: 'Corrupt integrity', exact: true }).click();
  await page.getByRole('button', { name: 'Run first', exact: true }).click();
  await expect(page.locator('#result')).toContainText('Rust module first could not load');
  await page.getByRole('button', { name: 'Restore registry', exact: true }).click();
  await page.getByRole('button', { name: 'Run first', exact: true }).click();
  await expect(page.locator('#result')).toContainText('kind');
  await expect(page.locator('body')).toHaveAttribute('data-workers', '1');
});

test('Python-only pages fetch no Rust module assets', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto('/guides/python-runtime/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Python Runtime Assets', exact: true })).toBeVisible();
  expect(requests.filter((url) => url.includes('/rust-wasm/') || url.includes('/rust-worker-'))).toEqual([]);
});
