import { expect, test } from '@playwright/test';

test('Rust definitions display source and share types and functions across runnable cells', async ({ page }) => {
  await page.goto('/features/interactive-cells/');
  for (const name of ['shared-model', 'shared-helper']) {
    const definition = page.getByTestId(`cell-features__interactive-cells__${name}`);
    await definition.scrollIntoViewIfNeeded();
    await expect(definition.getByTestId('cell-source')).toBeVisible();
    await expect(definition.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);
    await expect(definition.locator('input, select, textarea')).toHaveCount(0);
  }
  for (const [name, result] of [
    ['shared-first', '3'],
    ['shared-second', '5'],
    ['shared-transitive', '7']
  ]) {
    const cell = page.getByTestId(`cell-features__interactive-cells__${name}`);
    await cell.scrollIntoViewIfNeeded();
    await cell.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(cell.getByTestId('run-output')).toContainText(result);
  }
});
