import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

for (const renderer of ['canvas', 'svg']) {
  test(`exports current ${renderer} charts and supports keyboard controls`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:4323/?fixture=legend&renderer=${renderer}&theme=dark`);
    const figure = page.locator('.doc-chart-output');
    await expect(figure.locator(`.doc-plot > ${renderer === 'svg' ? 'div > svg' : 'div > canvas'}`)).toBeVisible();
    const series = figure.locator('.doc-chart-output__legend button[aria-pressed]').first();
    await series.focus();
    await page.keyboard.press('Enter');
    await expect(series).toHaveAttribute('aria-pressed', 'false');
    await figure.getByRole('button', { name: 'Show data as a table' }).focus();
    await page.keyboard.press('Space');
    await expect(figure.getByRole('table')).toBeVisible();
    await figure.getByRole('button', { name: 'Next page', exact: true }).focus();
    await page.keyboard.press('Enter');
    await figure.getByRole('button', { name: 'Hide data table' }).click();
    await expect(figure.getByRole('button', { name: 'Show data as a table' })).toBeFocused();
    await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.doc-plot');
      if (element)
        window.galleryECharts.getInstanceByDom(element)?.dispatchAction({ type: 'dataZoom', start: 20, end: 80 });
    });
    const plot = figure.locator('.doc-plot');
    const size = await plot.evaluate((element) => {
      const chart = window.galleryECharts.getInstanceByDom(element as HTMLElement);
      return { width: chart?.getWidth() ?? 0, height: chart?.getHeight() ?? 0 };
    });
    for (const format of ['SVG', 'PNG']) {
      const download = page.waitForEvent('download');
      await figure.getByRole('button', { name: `Save ${format}` }).click();
      const file = await download;
      const path = await file.path();
      expect(path).not.toBeNull();
      const content = await readFile(path as string);
      if (format === 'SVG') {
        expect(content.toString()).toContain('<svg');
        expect(content.toString()).toContain(`width="${size.width}"`);
        expect(content.toString()).not.toContain('<animate');
      } else {
        expect(content.readUInt32BE(16)).toBe(size.width * 2);
        expect(content.readUInt32BE(20)).toBe(size.height * 2);
      }
    }
    await expect(series).toHaveAttribute('aria-pressed', 'false');
    await figure.getByRole('button', { name: 'Reset zoom' }).focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const element = document.querySelector<HTMLElement>('.doc-plot');
          const option = element && window.galleryECharts.getInstanceByDom(element)?.getOption();
          return (option?.dataZoom as { start: number; end: number }[])?.map(({ start, end }) => [start, end]);
        })
      )
      .toEqual([[0, 100]]);
    expect((await new AxeBuilder({ page }).include('.doc-chart-output').analyze()).violations).toEqual([]);
    await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
    await expect(figure.locator('.doc-chart-output__actions')).toBeHidden();
    await expect(plot).toBeVisible();
  });
}
