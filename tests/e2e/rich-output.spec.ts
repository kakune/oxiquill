import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator } from '@playwright/test';

for (const locale of ['en', 'ja']) {
  for (const theme of ['light', 'dark']) {
    test(`formatted tables and outcomes stay accessible and stale on mobile (${locale}, ${theme})`, async ({
      page,
      browserName
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.addInitScript((theme) => localStorage.setItem('starlight-theme', theme), theme);
      await page.goto(`${locale === 'ja' ? '/ja' : ''}/features/rich-output/`);
      const cell = page.getByTestId(`cell-${locale === 'ja' ? 'ja__' : ''}features__rich-output__column-formats`);
      await hydrateCell(cell);
      const run = cell.getByRole('button', { name: locale === 'ja' ? '実行' : 'Run', exact: true });
      await run.click();
      const outcome = cell.locator('[data-outcome="partial"]');
      await expect(outcome).toContainText('Iteration limit reached');
      await expect(cell.getByRole('alert')).toHaveCount(0);
      await expect(cell.locator('.doc-cell__outputs').locator(':scope > :first-child')).toHaveAttribute(
        'data-outcome',
        'partial'
      );
      await expect(cell.getByRole('status').nth(0)).toContainText(locale === 'ja' ? '実行が完了' : 'Cell completed.');
      await expect(cell.getByRole('status').nth(1)).toContainText('Iteration limit reached');
      const table = cell.getByTestId('table-output');
      await expect(table.getByRole('button', { name: 'Time (s)', exact: true })).toBeVisible();
      await expect(table.getByText('1.23', { exact: true })).toHaveCount(2);
      await expect(table.getByText('Not measured', { exact: true })).toBeVisible();
      await table.getByRole('button', { name: 'Time (s)', exact: true }).click();
      await expect(table.getByRole('row').nth(1).getByRole('cell').nth(2)).toHaveAttribute('title', '1.2341');
      const downloadPromise = page.waitForEvent('download');
      await table.getByTestId('table-save-csv').click();
      const download = await downloadPromise;
      const file = await download.path();
      expect(file).not.toBeNull();
      const csv = await readFile(file as string, 'utf8');
      expect(csv).toContain('Count,Residual,Time (s),Optional');
      expect(csv).toContain('500,0.002,1.2349,');
      expect(csv).toContain('500,0.002,1.2341,0');
      const scroller = table.locator('.doc-table-output__scroller');
      await scroller.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      const wrapper = cell.locator('.doc-cell__retained-output');
      const tableTop = () => table.evaluate((element) => element.getBoundingClientRect().top + scrollY);
      const top = await tableTop();
      await cell.getByRole('spinbutton', { name: 'Iterations' }).fill('1000');
      await expect(wrapper).toHaveAttribute('data-stale', 'true');
      // The previous-input note overlays the output, so the table does not move.
      await expect(cell.locator('.doc-cell__status').getByRole('note')).toContainText(
        locale === 'ja' ? '変更前の入力' : 'previous inputs'
      );
      expect(await tableTop()).toBe(top);
      if (browserName === 'chromium') {
        const accessibility = await new AxeBuilder({ page })
          .include(`[data-testid="${await cell.getAttribute('data-testid')}"]`)
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(accessibility.violations).toEqual([]);
      }
      await run.click();
      await expect(cell.locator('[data-outcome="satisfied"]')).toBeVisible();
      await expect(wrapper).not.toHaveAttribute('data-stale');
    });
  }
}

test('Haskell emits descriptor columns and a satisfied outcome', async ({ page }) => {
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__satisfied-outcome');
  await hydrateCell(cell);
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.locator('[data-outcome="satisfied"]')).toContainText('Criterion met', { timeout: 30_000 });
  await expect(cell.getByRole('button', { name: 'Time (s)', exact: true })).toBeVisible();
  await expect(cell.getByText('Not measured', { exact: true })).toBeVisible();
  await expect(cell.getByRole('alert')).toHaveCount(0);
});

test('Python emits an unavailable outcome without an execution error', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__unavailable-outcome');
  await hydrateCell(cell);
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.locator('[data-outcome="unavailable"]')).toContainText('GPU computation unavailable', {
    timeout: 60_000
  });
  await expect(cell.getByRole('button', { name: 'Time (s)', exact: true })).toBeVisible();
  await expect(cell.getByRole('alert')).toHaveCount(0);
});

async function hydrateCell(cell: Locator): Promise<void> {
  await cell.scrollIntoViewIfNeeded();
  await expect(cell.locator('xpath=ancestor::astro-island[1]')).not.toHaveAttribute('ssr', '', { timeout: 30_000 });
}

test('column layouts pair charts only when the cell has room', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__paired-figures');
  await hydrateCell(cell);
  const outputs = cell.locator('.doc-cell__outputs[data-layout="columns"]');
  const charts = outputs.locator(':scope > .doc-chart-output');
  await expect(charts).toHaveCount(2);
  await expect(outputs.locator(':scope > .doc-output-artifact')).toContainText('Text outputs keep the full width');
  const boxes = () =>
    outputs.locator(':scope > *').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width) };
      })
    );

  const [first, second, text] = await boxes();
  expect(second.top).toBe(first.top);
  expect(second.left).toBeGreaterThan(first.left + first.width - 1);
  expect(text.top).toBeGreaterThan(first.top);
  expect(text.width).toBeGreaterThan(first.width + second.width);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const [chart, nextChart] = await boxes();
      return nextChart.top > chart.top;
    })
    .toBe(true);
  const [narrowFirst, narrowSecond] = await boxes();
  expect(narrowSecond.width).toBe(narrowFirst.width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0
  );
});
