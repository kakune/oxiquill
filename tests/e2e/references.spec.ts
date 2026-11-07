import { expect, test } from '@playwright/test';

for (const locale of ['', 'ja/']) {
  test(`stable heading and cell references resolve in ${locale || 'root'}`, async ({ page }) => {
    await page.goto(`/${locale}guides/authoring/`);
    const headingLink = page.locator('main a[href="#ox-ref-authoring-cell-behavior"]');
    await expect(headingLink).toHaveCount(1);
    await headingLink.click();
    const anchor = page.locator('#ox-ref-authoring-cell-behavior');
    await expect(anchor).toBeAttached();
    const heading = anchor.locator('xpath=following-sibling::*[1]');
    await expect(heading).toHaveAttribute('id', locale ? 'セルの動作を設定する' : 'configure-cell-behavior');
    const top = await anchor.evaluate((node) => node.getBoundingClientRect().top);
    const navBottom = await page.locator('header.header').evaluate((node) => node.getBoundingClientRect().bottom);
    expect(top).toBeGreaterThanOrEqual(navBottom);

    const cellLink = page.locator(`main a[href="/${locale}features/interactive-cells/#ox-ref-cell-autorun"]`);
    await expect(cellLink).toHaveCount(1);
    await cellLink.click();
    const cell = page.locator('#ox-ref-cell-autorun');
    await expect(cell).toHaveAttribute(
      'data-cell-id',
      `${locale ? 'ja__' : ''}features__interactive-cells__run-mode-autorun`
    );
    await expect(cell.locator('h3[id]')).toHaveCount(1);
  });
}
