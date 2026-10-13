import { expect, test } from '@playwright/test';

for (const renderer of ['canvas', 'svg']) {
  for (const fixture of ['denseLine', 'denseScatter']) {
    test(`large ${fixture} retains interaction and exports with ${renderer}`, async ({ page }) => {
      await page.goto(`http://127.0.0.1:4323/?fixture=${fixture}&renderer=${renderer}`);
      const figure = page.locator('.doc-chart-output');
      await expect(figure.getByRole('button', { name: 'Save SVG' })).toBeEnabled();
      const hover = async (value: number) => {
        const point = await page.evaluate((value) => {
          const element = document.querySelector<HTMLElement>('.doc-plot');
          const chart = element && window.galleryECharts.getInstanceByDom(element);
          if (!element || !chart) throw new Error('Chart did not initialize.');
          const [x, y] = chart.convertToPixel({ seriesIndex: 0 }, [5000, value]) as number[];
          const rect = element.getBoundingClientRect();
          return { x: rect.left + element.clientLeft + x, y: rect.top + element.clientTop + y + 1 };
        }, value);
        await page.mouse.move(point.x, point.y);
      };
      if (fixture === 'denseLine') {
        // A pixel spans many original points before zoom; select the retained spike by raw index.
        await figure
          .locator('.doc-plot')
          .evaluate((element) =>
            window.galleryECharts
              .getInstanceByDom(element as HTMLElement)
              ?.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: 5000 })
          );
      } else await hover(100);
      await expect(figure.locator('.doc-plot')).toContainText('100');
      await page.evaluate(() => {
        const element = document.querySelector<HTMLElement>('.doc-plot');
        if (element)
          window.galleryECharts
            .getInstanceByDom(element)
            ?.dispatchAction({ type: 'dataZoom', startValue: 4990, endValue: 5010 });
        document.documentElement.dataset.theme = 'dark';
      });
      await page.getByRole('button', { name: 'Update data', exact: true }).click();
      await expect(figure.locator('figcaption')).toContainText('Revision 1');
      const state = await page.evaluate(() => {
        const element = document.querySelector<HTMLElement>('.doc-plot');
        const option = element && window.galleryECharts.getInstanceByDom(element)?.getOption();
        const series = option?.series as { data: number[][]; sampling?: string; large?: boolean }[];
        const zoom = option?.dataZoom as { startValue: number; endValue: number }[];
        return { count: series[0].data.length, zoom: [zoom[0].startValue, zoom[0].endValue] };
      });
      expect(state).toEqual({ count: fixture === 'denseLine' ? 100000 : 10000, zoom: [4990, 5010] });
      await hover(fixture === 'denseLine' ? 101 : 100);
      await expect(figure.locator('.doc-plot')).toContainText(fixture === 'denseLine' ? '101' : '100');
      await figure.getByRole('button', { name: 'Show data as a table' }).click();
      await expect(figure.getByRole('table')).toBeVisible();
      await expect(figure.getByRole('table').locator('tbody tr')).toHaveCount(10);
      await figure.getByRole('button', { name: 'Hide data table' }).click();
      for (const format of ['PNG', 'SVG']) {
        const pending = page.waitForEvent('download');
        await figure.getByRole('button', { name: `Save ${format}` }).click();
        expect((await pending).suggestedFilename()).toMatch(new RegExp(`\\.${format.toLowerCase()}$`, 'u'));
      }
      await expect(figure.getByRole('alert')).toHaveCount(0);
    });
  }
}
