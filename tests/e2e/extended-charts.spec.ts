import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function view(page: Page) {
  return page.locator('.doc-plot').evaluate((element) => {
    const chart = window.galleryECharts.getInstanceByDom(element as HTMLElement);
    if (!chart) throw new Error('Chart is not ready.');
    const option = chart.getOption() as {
      series: { id: string; data: unknown[] }[];
      dataZoom?: { start: number; end: number }[];
      visualMap?: { range: number[] }[];
    };
    return {
      id: chart.id,
      data: option.series[0]?.data,
      zoom: option.dataZoom?.map(({ start, end }) => ({ start, end })),
      colors: option.visualMap?.map(({ range }) => range)
    };
  });
}

for (const fixture of [
  'stackedBars',
  'stackedAreas',
  'horizontalBars',
  'errorBars',
  'intervalBand',
  'annotations',
  'divergingHeatmap',
  'boxplot',
  'bubble',
  'field'
]) {
  test(`${fixture} updates, retains reader state, and exports its data and SVG`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`http://127.0.0.1:4323/?fixture=${fixture}&width=360`);
    await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    const details: Record<string, string> = {
      stackedBars: 'First: 2',
      stackedAreas: 'Second: 3',
      horizontalBars: 'North America (estimate)',
      errorBars: 'Lower boundary: -5',
      intervalBand: 'Upper boundary: -2',
      divergingHeatmap: ': -2',
      boxplot: 'Median: -2',
      bubble: 'Size: 25',
      field: 'X: [-3, -1)'
    };
    if (details[fixture]) {
      await page
        .locator('.doc-plot')
        .evaluate((element) =>
          window.galleryECharts
            .getInstanceByDom(element as HTMLElement)
            ?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 0 })
        );
      await expect(page.locator('.doc-plot')).toContainText(details[fixture]);
      await page
        .locator('.doc-plot')
        .evaluate((element) =>
          window.galleryECharts.getInstanceByDom(element as HTMLElement)?.dispatchAction({ type: 'hideTip' })
        );
    }
    await page.locator('.doc-plot').evaluate((element, fixture) => {
      const chart = window.galleryECharts.getInstanceByDom(element as HTMLElement);
      if (fixture === 'divergingHeatmap') chart?.dispatchAction({ type: 'selectDataRange', selected: [-0.5, 0.5] });
      else chart?.dispatchAction({ type: 'dataZoom', start: 20, end: 80 });
    }, fixture);
    const before = await view(page);
    await page.getByRole('button', { name: 'Update data' }).click();
    await expect(page.locator('figcaption')).toContainText('Revision 1');
    await expect.poll(async () => (await view(page)).data).not.toEqual(before.data);
    await expect.poll(async () => (await view(page)).zoom).toEqual(before.zoom);
    const afterUpdate = await view(page);
    if (fixture !== 'field') expect(afterUpdate.colors).toEqual(before.colors);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await expect(page.locator('.doc-plot')).toHaveAttribute('data-chart-theme', 'dark');
    expect((await view(page)).id).toBe(before.id);
    expect((await view(page)).colors).toEqual(afterUpdate.colors);
    if (testInfo.project.name === 'chromium')
      await page.locator('.doc-chart-output').screenshot({ path: testInfo.outputPath('gallery-' + fixture + '.png') });
    await page.getByRole('button', { name: 'Show data as a table' }).click();
    await expect(page.getByRole('table')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save SVG', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.svg$/u);
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });
}

test('removing annotations clears their labels and geometry', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=annotations&renderer=svg');
  await expect(page.locator('.doc-plot')).toContainText('Threshold');
  await page.getByRole('button', { name: 'Clear annotations' }).click();
  await expect(page.locator('.doc-plot')).not.toContainText('Threshold');
  await expect(page.locator('.doc-chart-output__summary')).not.toContainText('Threshold');
});
