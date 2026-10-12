import { expect, test } from '@playwright/test';

test('Haskell renders ordered JSON, table, and chart output', async ({ page }) => {
  await page.goto('/samples/haskell-series/');
  const cell = page.getByTestId('cell-samples__haskell-series__haskell-structured-output');
  await cell.scrollIntoViewIfNeeded();
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(cell.getByTestId('value-output')).toContainText('"ready": true');
  await expect(cell.getByTestId('table-output')).toContainText('Square');
  await expect(cell.getByTestId('table-output')).toContainText('16');
  await expect(cell.getByTestId('doc-plot')).toBeVisible();
  const text = await cell.locator('.doc-cell__outputs').innerText();
  expect(text.indexOf('Before structured output')).toBeLessThan(text.indexOf('"ready"'));
  expect(text.indexOf('"ready"')).toBeLessThan(text.indexOf('After structured output'));
});
