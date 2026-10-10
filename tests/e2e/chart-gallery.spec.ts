import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    galleryECharts: typeof import('../../packages/oxiquill/node_modules/echarts/core');
  }
}

for (const width of [360, 720]) {
  for (const theme of ['light', 'dark']) {
    test(`chart gallery ${width}px ${theme}`, async ({ page, browserName }, testInfo) => {
      test.skip(browserName !== 'chromium', 'Chromium captures the shared visual review artifacts.');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: width + 40, height: 900 });
      await page.goto(`http://127.0.0.1:4323/?width=${width}&theme=${theme}`);
      await expect(page.locator('.doc-plot')).toHaveCount(21);
      await expect
        .poll(() =>
          page.locator('.doc-plot').evaluateAll((plots) => plots.every((plot) => plot.querySelector('canvas')))
        )
        .toBe(true);
      await expect(page.locator('[role="alert"]')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`gallery-${width}-${theme}.png`), fullPage: true });
    });
  }
}

async function action(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((value) => {
    const plot = document.querySelector<HTMLElement>('.doc-plot');
    const chart = plot && window.galleryECharts.getInstanceByDom(plot);
    if (!chart) throw new Error('Chart is not ready.');
    chart.dispatchAction(value as { type: string });
  }, payload);
}

async function state(page: Page) {
  return page.evaluate(() => {
    const plot = document.querySelector<HTMLElement>('.doc-plot');
    const chart = plot && window.galleryECharts.getInstanceByDom(plot);
    if (!chart) throw new Error('Chart is not ready.');
    const options = chart.getOption() as {
      dataZoom?: { start: number; end: number }[];
      legend?: { scrollDataIndex: number; selected: Record<string, boolean> }[];
      series: { showSymbol: boolean }[];
    };
    return {
      zoom: options.dataZoom?.map(({ start, end }) => ({ start, end })),
      legend: options.legend?.map(({ scrollDataIndex, selected }) => ({ scrollDataIndex, selected })),
      symbols: options.series.map((series) => series.showSymbol)
    };
  });
}

test('chart updates and resize retain zoom, and isolated zoom points remain visible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:4323/?fixture=years&width=360');
  await expect(page.locator('canvas')).toHaveCount(1);
  await action(page, { type: 'dataZoom', start: 51, end: 53 });
  await expect.poll(async () => (await state(page)).symbols).toEqual([true]);
  const before = await state(page);
  await page.getByRole('button', { name: 'Update data' }).click();
  await expect(page.locator('figcaption')).toContainText('Updated years');
  await page.locator('main').evaluate((element) => (element.style.width = '720px'));
  await expect.poll(async () => (await state(page)).zoom).toEqual(before.zoom);
  await action(page, { type: 'dataZoom', start: 0, end: 100 });
  await expect.poll(async () => (await state(page)).symbols).toEqual([false]);
});

test('legend scrolling and selection survive data and title updates', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=legend&width=360');
  await expect(page.locator('canvas')).toHaveCount(1);
  await action(page, { type: 'legendScroll', scrollDataIndex: 3 });
  await action(page, { type: 'legendUnSelect', name: 'A long descriptive name for measurement series 1' });
  const before = await state(page);
  await page.getByRole('button', { name: 'Update data' }).click();
  await expect(page.locator('figcaption')).toContainText('Updated legend');
  expect((await state(page)).legend).toEqual(before.legend);
});

test('UTC labels and tooltips agree across reader timezones', async ({ browser }) => {
  for (const locale of ['en', 'ja']) {
    const results = [];
    for (const timezoneId of ['UTC', 'Asia/Tokyo', 'America/New_York']) {
      const context = await browser.newContext({ timezoneId, reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:4323/?fixture=time&locale=${locale}`);
        await expect(page.locator('canvas')).toHaveCount(1);
        await action(page, { type: 'showTip', seriesIndex: 0, dataIndex: 0 });
        results.push(
          await page.evaluate(() => {
            const plot = document.querySelector<HTMLElement>('.doc-plot');
            const chart = plot && window.galleryECharts.getInstanceByDom(plot);
            if (!chart) throw new Error('Chart is not ready.');
            const options = chart.getOption() as { xAxis: { axisLabel: { formatter: (value: number) => string } }[] };
            return {
              tick: options.xAxis[0].axisLabel.formatter(Date.parse('2024-03-10T06:30:00Z')),
              summary: document.querySelector('.doc-chart-output__summary')?.textContent,
              tooltip: plot?.textContent
            };
          })
        );
      } finally {
        await context.close();
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(results[0].summary).toContain('UTC');
    expect(results[0].tooltip).toContain('UTC');
  }
});

test('charts remain present for forced colors and print', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=legend');
  await expect(page.locator('canvas')).toHaveCount(1);
  for (const media of [
    { forcedColors: 'active' as const },
    { forcedColors: 'none' as const, media: 'print' as const }
  ]) {
    await page.emulateMedia(media);
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.locator('figcaption')).toContainText('Long series names');
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  }
});

test('maximum-length titles and axis names stay within a narrow figure', async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 900 });
  await page.goto('http://127.0.0.1:4323/?fixture=years&width=360&longText=1');
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.locator('figcaption strong')).toHaveText('T'.repeat(16000));
  await expect(page.locator('.doc-chart-output__summary')).toContainText('X'.repeat(16000));
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
});
