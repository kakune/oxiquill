import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

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
      await cell.scrollIntoViewIfNeeded();
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
      await cell.getByRole('spinbutton', { name: 'Iterations' }).fill('1000');
      await expect(wrapper).toHaveAttribute('data-stale', 'true');
      await expect(wrapper.getByRole('note')).toContainText(locale === 'ja' ? '変更前の入力' : 'previous inputs');
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
  await cell.scrollIntoViewIfNeeded();
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.locator('[data-outcome="satisfied"]')).toContainText('Criterion met');
  await expect(cell.getByRole('button', { name: 'Time (s)', exact: true })).toBeVisible();
  await expect(cell.getByText('Not measured', { exact: true })).toBeVisible();
  await expect(cell.getByRole('alert')).toHaveCount(0);
});

test('Python emits an unavailable outcome without an execution error', async ({ page }) => {
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__unavailable-outcome');
  await cell.scrollIntoViewIfNeeded();
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.locator('[data-outcome="unavailable"]')).toContainText('GPU computation unavailable', {
    timeout: 60_000
  });
  await expect(cell.getByRole('button', { name: 'Time (s)', exact: true })).toBeVisible();
  await expect(cell.getByRole('alert')).toHaveCount(0);
});
