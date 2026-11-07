import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

for (const locale of ['', 'ja/']) {
  test(`built ${locale || 'en/'} mixed XY example updates and exposes all layer coordinates`, async ({ page }) => {
    await page.goto(`/${locale}features/rich-output/`);
    const prefix = locale ? 'ja__' : '';
    const cell = page.getByTestId(`cell-${prefix}features__rich-output__mixed-xy-layers`);
    await expect(cell.locator('.doc-plot canvas')).toBeVisible({ timeout: 60_000 });
    await expect(cell.locator('.doc-chart-output__legend button')).toHaveCount(3);
    const samples = cell.getByRole('button', { name: 'Samples', exact: true });
    await samples.click();
    await expect(samples).toHaveAttribute('aria-pressed', 'false');
    await cell.locator('input[type="range"]').fill('0.3');
    await expect(samples).toHaveAttribute('aria-pressed', 'false');
    await cell.locator('.doc-chart-output__actions button').first().click();
    await expect(cell.getByRole('table')).toContainText('uncertainty');
    await expect(cell.getByRole('table')).toContainText('reference');
    await expect(cell.getByRole('table')).toContainText('scatter');
    await expect(cell.getByRole('table')).toContainText('0.3');
    await expect(cell.locator('[role="alert"]')).toHaveCount(0);
  });
}

test('mixed layers retain selection after reordering and export PNG and SVG', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=mixedXy&renderer=svg');
  await expect(page.locator('.doc-plot svg')).toBeVisible();
  const samples = page.getByRole('button', { name: 'Samples', exact: true });
  await samples.click();
  await page.getByRole('button', { name: 'Reorder and rename series' }).click();
  await expect(samples).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(page.locator('.doc-plot')).toHaveAttribute('data-chart-theme', 'dark');
  for (const format of ['PNG', 'SVG']) {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: `Save ${format}`, exact: true }).click();
    const download = await pending;
    const path = await download.path();
    if (!path) throw new Error('Missing exported file');
    const bytes = await readFile(path);
    if (format === 'PNG') expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    else {
      expect(bytes.toString()).toContain('<svg');
      expect(bytes.toString()).not.toContain('#cc6633');
      expect(bytes.toString()).toContain('#88bbff');
    }
  }
});
