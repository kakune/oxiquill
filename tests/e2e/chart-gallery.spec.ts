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
      await expect(page.locator('.doc-plot')).toHaveCount(25);
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
  await action(page, { type: 'legendUnSelect', name: 'line:0' });
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

test('heatmap scales change orientation when resizing across 600px', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=heatmap&width=360');
  await expect(page.locator('canvas').first()).toBeVisible();
  const orientation = () =>
    page.evaluate(() => {
      const plot = document.querySelector<HTMLElement>('.doc-plot');
      const chart = plot && window.galleryECharts.getInstanceByDom(plot);
      return (chart?.getOption() as { visualMap?: { orient: string }[] })?.visualMap?.[0].orient;
    });
  await expect.poll(orientation).toBe('horizontal');
  await page.locator('main').evaluate((element) => (element.style.width = '720px'));
  await expect.poll(orientation).toBe('vertical');
  await page.locator('main').evaluate((element) => (element.style.width = '599px'));
  await expect.poll(orientation).toBe('horizontal');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test('histogram density uses numeric intervals and survives a partial-bin zoom', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://127.0.0.1:4323/?fixture=histogramDensity');
  await expect(page.locator('canvas')).toHaveCount(1);
  await action(page, { type: 'showTip', seriesIndex: 0, dataIndex: 1 });
  await expect(page.locator('.doc-plot')).toContainText('[0.3, 0.7): Density: 7.5');
  await action(page, { type: 'dataZoom', startValue: -0.75, endValue: 2 });
  const option = await page
    .locator('.doc-plot')
    .evaluate((element) => window.galleryECharts.getInstanceByDom(element as HTMLElement)?.getOption());
  expect(option).toMatchObject({ xAxis: [{ type: 'value' }], series: [{ type: 'custom', encode: { x: [0, 1] } }] });
  await expect(page.locator('.doc-chart-output__summary')).toContainText('Density');
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

for (const fixture of ['legend', 'heatmap']) {
  test(`theme changes preserve the instance and reader selections for ${fixture}`, async ({ page }) => {
    await page.goto(`http://127.0.0.1:4323/?fixture=${fixture}`);
    await expect(page.locator('canvas').first()).toBeVisible();
    if (fixture === 'legend') {
      await action(page, { type: 'dataZoom', start: 20, end: 70 });
      await action(page, { type: 'legendUnSelect', name: 'line:0' });
      await action(page, { type: 'legendScroll', scrollDataIndex: 3 });
    } else await action(page, { type: 'selectDataRange', selected: [0.2, 0.6] });
    const read = () =>
      page.locator('.doc-plot').evaluate((element) => {
        const chart = window.galleryECharts.getInstanceByDom(element as HTMLElement);
        const options = chart?.getOption() as {
          dataZoom?: unknown;
          legend?: { selected?: unknown; scrollDataIndex?: number }[];
          visualMap?: { range?: unknown }[];
        };
        return {
          id: chart?.id,
          zoom: options.dataZoom,
          legend: options.legend?.map(({ selected, scrollDataIndex }) => ({ selected, scrollDataIndex })),
          range: options.visualMap?.[0]?.range
        };
      });
    const before = await read();
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(page.locator('.doc-plot')).toHaveAttribute('data-chart-theme', theme);
      await expect.poll(read).toEqual(before);
    }
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
  });
}

test('authored number formats can be cleared without resetting zoom', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=formatted');
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.locator('.doc-chart-output__summary')).toContainText('1.50 kV');
  await action(page, { type: 'dataZoom', start: 10, end: 90 });
  const before = await state(page);
  await page.getByRole('button', { name: 'Clear formatting' }).click();
  await expect(page.locator('.doc-chart-output__summary')).not.toContainText('kV');
  await expect.poll(async () => (await state(page)).zoom).toEqual(before.zoom);
});

test('same-named series retain independent selection after reorder and rename', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=seriesIdentity');
  await expect(page.locator('canvas').first()).toBeVisible();
  await action(page, { type: 'legendUnSelect', name: 'line:id:a' });
  await action(page, { type: 'dataZoom', start: 10, end: 90 });
  const before = await state(page);
  await page.getByRole('button', { name: 'Reorder and rename series' }).click();
  await expect(page.locator('.doc-chart-output__summary')).toContainText('Renamed');
  await expect.poll(async () => (await state(page)).legend?.[0].selected).toEqual(before.legend?.[0].selected);
  await expect.poll(async () => (await state(page)).zoom).toEqual(before.zoom);
  const series = await page.locator('.doc-plot').evaluate((element) => {
    const option = window.galleryECharts.getInstanceByDom(element as HTMLElement)?.getOption() as {
      series: { id: string; smooth: boolean; step: boolean; symbol: string }[];
    };
    return option.series.map(({ id, smooth, step, symbol }) => ({ id, smooth, step, symbol }));
  });
  expect(series.find((item) => item.id === 'line:id:a')).toMatchObject({
    smooth: false,
    step: false,
    symbol: 'emptyCircle'
  });
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
});

test('fixed ranges survive data updates and only reset zoom when changed or cleared', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=legend&fixedRange=1');
  await expect(page.locator('canvas').first()).toBeVisible();
  await action(page, { type: 'legendUnSelect', name: 'line:0' });
  await action(page, { type: 'dataZoom', start: 20, end: 80 });
  const before = await state(page);
  const bounds = () =>
    page.locator('.doc-plot').evaluate((element) => {
      const option = window.galleryECharts.getInstanceByDom(element as HTMLElement)?.getOption() as {
        yAxis: { min: number | null; max: number | null }[];
      };
      return [option.yAxis[0].min, option.yAxis[0].max];
    });
  await page.getByRole('button', { name: 'Update data' }).click();
  await expect(page.locator('figcaption')).toContainText('Updated legend');
  expect(await bounds()).toEqual([0, 120]);
  expect((await state(page)).zoom).toEqual(before.zoom);
  await page.getByRole('button', { name: 'Change range' }).click();
  await expect.poll(bounds).toEqual([0, 200]);
  await expect.poll(async () => (await state(page)).zoom).toEqual([{ start: 0, end: 100 }]);
  expect((await state(page)).legend?.[0].selected).toEqual(before.legend?.[0].selected);
  await action(page, { type: 'dataZoom', start: 20, end: 80 });
  await page.getByRole('button', { name: 'Clear range' }).click();
  await expect.poll(bounds).toEqual([null, null]);
  await expect.poll(async () => (await state(page)).zoom).toEqual([{ start: 0, end: 100 }]);
  expect((await state(page)).legend?.[0].selected).toEqual(before.legend?.[0].selected);
});
