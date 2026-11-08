import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    cellRequests: string[];
  }
}
const prefix = 'features__interactive-cells__';
const requests = (page: Page, id: string) =>
  page.evaluate((cellId) => window.cellRequests.filter((id) => id === cellId).length, `${prefix}${id}`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const requests: string[] = [];
    window.cellRequests = requests;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]): void {
        if (message && typeof message === 'object' && 'cellId' in message && typeof message.cellId === 'string')
          requests.push(message.cellId);
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
});

test('offscreen producers, typed chain, propagation, cache reuse, and forced recomputation', async ({ page }) => {
  await page.goto(`/features/interactive-cells/#doc-cell-${prefix}analyze-data-title`);
  const producer = page.getByTestId(`cell-${prefix}generate-data`);
  const summary = page.getByTestId(`cell-${prefix}summarize-data`);
  const analysis = page.getByTestId(`cell-${prefix}analyze-data`);
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 143');
  await expect.poll(() => requests(page, 'generate-data')).toBe(1);
  // The producer executed without needing its client:visible island.
  await expect(producer.locator('xpath=ancestor::astro-island')).toHaveAttribute('ssr', '');
  await producer.scrollIntoViewIfNeeded();
  await expect(producer.getByTestId('run-output')).toContainText('Generated 20 points with seed 1');
  await expect(producer.locator('.doc-cell__outputs')).not.toContainText('truth');

  await analysis.getByRole('spinbutton', { name: 'Bias' }).fill('5');
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 148');
  await expect(producer.getByRole('status').filter({ hasText: 'Reused result for these inputs' })).toHaveCount(1);
  expect(await requests(page, 'generate-data')).toBe(1);
  expect(await requests(page, 'summarize-data')).toBe(1);

  await summary.scrollIntoViewIfNeeded();
  await summary.getByRole('button', { name: 'Recompute', exact: true }).click();
  await expect.poll(() => requests(page, 'summarize-data')).toBe(2);
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 148');
  expect(await requests(page, 'generate-data')).toBe(1);

  await producer.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('2');
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 152');
  expect(await requests(page, 'generate-data')).toBe(2);
  await producer.getByRole('spinbutton', { name: 'Seed', exact: true }).fill('1');
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 148');
  expect(await requests(page, 'generate-data')).toBe(2);
  await producer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect.poll(() => requests(page, 'generate-data')).toBe(3);

  await analysis.getByRole('button', { name: 'Copy input link' }).click();
  // The share contract contains inputs/cases only, never the export channel.
  const metadata = await producer.getAttribute('data-share-inputs');
  expect(metadata).not.toContain('points');
  expect(metadata).not.toContain('truth');
  await page.goto('/features/math/');
  await page.goto(`/features/interactive-cells/#doc-cell-${prefix}analyze-data-title`);
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 143');
  expect(await requests(page, 'generate-data')).toBe(1);
});

test('Japanese graph cells provide localized cache controls and reuse status', async ({ page }) => {
  const localPrefix = `ja__${prefix}`;
  await page.goto(`/ja/features/interactive-cells/#doc-cell-${localPrefix}analyze-data-title`);
  const analysis = page.getByTestId(`cell-${localPrefix}analyze-data`);
  const producer = page.getByTestId(`cell-${localPrefix}generate-data`);
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 143');
  await producer.scrollIntoViewIfNeeded();
  await expect(producer.getByRole('button', { name: '再計算' })).toBeVisible();
  await analysis.getByRole('spinbutton', { name: '補正' }).fill('5');
  await expect(analysis.getByTestId('run-output')).toContainText('Analysis: 148');
  await expect(producer.getByRole('status').filter({ hasText: '同じ入力の結果を再利用しました' })).toHaveCount(1);
});

test('upstream failures and timeouts link to diagnostics and recover without old exports', async ({ page }) => {
  await page.goto('/tests/data-dependencies/');
  const prefix = 'tests__data-dependencies__';
  const producer = page.getByTestId(`cell-${prefix}failable-producer`);
  const consumer = page.getByTestId(`cell-${prefix}failure-consumer`);
  await consumer.scrollIntoViewIfNeeded();
  await consumer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consumer.getByTestId('run-output')).toContainText('Derived 8');
  await producer.getByRole('checkbox', { name: 'Reject export' }).check();
  await expect(producer.getByRole('alert')).toContainText('missing export value');
  await expect(consumer.getByText('Upstream changed', { exact: true })).toBeVisible();
  await consumer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consumer.getByRole('link', { name: 'Upstream cell "Failable producer" failed' })).toHaveAttribute(
    'href',
    `#doc-cell-${prefix}failable-producer-title`
  );
  await expect(consumer.locator('[data-stale="true"]')).toContainText('Derived 8');
  await producer.getByRole('checkbox', { name: 'Reject export' }).uncheck();
  await expect(producer.getByText('Reused result for these inputs')).toBeVisible();
  await consumer.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(consumer.getByRole('alert')).toHaveCount(0);

  const timeout = page.getByTestId(`cell-${prefix}timeout-producer`);
  const waiting = page.getByTestId(`cell-${prefix}timeout-consumer`);
  await timeout.scrollIntoViewIfNeeded();
  await timeout.getByRole('checkbox', { name: 'Wait indefinitely' }).check();
  await expect(timeout.getByRole('alert')).toContainText('timed out after 1000ms');
  await waiting.scrollIntoViewIfNeeded();
  await waiting.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(waiting.getByRole('link', { name: 'Upstream cell "Timeout producer" failed' })).toBeVisible();
  await expect(waiting.getByRole('alert')).toContainText('timed out after 1000ms');
  await timeout.getByRole('checkbox', { name: 'Wait indefinitely' }).uncheck();
  await waiting.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(waiting.getByTestId('run-output')).toContainText('Recovered 1');
  await expect(waiting.getByRole('alert')).toHaveCount(0);
});
