import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';

async function geometry(page: Page, figure: Locator) {
  const targets = figure.locator(
    '.doc-chart-output__actions > button, .doc-chart-output__actions > .doc-disclosure > button'
  );
  const boxes = await targets.evaluateAll((buttons) =>
    buttons.map((button) => {
      const { top, width, height } = button.getBoundingClientRect();
      return { top, width, height };
    })
  );
  expect(boxes).toHaveLength(3);
  expect(Math.max(...boxes.map(({ top }) => top)) - Math.min(...boxes.map(({ top }) => top))).toBeLessThan(1);
  for (const { width, height } of boxes) {
    expect(width).toBeGreaterThanOrEqual(44);
    expect(height).toBeGreaterThanOrEqual(44);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
  ).toBe(true);
}

for (const width of [320, 390, 430]) {
  for (const locale of ['en', 'ja']) {
    test(`built compact chart controls at ${width}px (${locale})`, async ({ page, browserName }, testInfo) => {
      const labels = labelsForLanguage(locale);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => localStorage.setItem('starlight-theme', 'dark'));
      await page.goto(`${locale === 'ja' ? '/ja' : ''}/features/rich-output/`);
      const cell = page.getByTestId(`cell-${locale === 'ja' ? 'ja__' : ''}features__rich-output__compact-series`);
      await cell.scrollIntoViewIfNeeded();
      const figure = cell.locator('.doc-chart-output');
      await expect(figure.locator('.doc-plot canvas')).toBeVisible({ timeout: 60_000 });
      const series = figure.locator('button[aria-controls$="-series"]');
      await expect(series).toHaveAttribute('aria-expanded', 'false');
      await geometry(page, figure);
      await expect(figure.getByRole('button', { name: 'Series 1', exact: true })).toHaveCount(0);
      if (width === 390 && browserName === 'chromium')
        await figure.screenshot({ path: testInfo.outputPath(`gallery-compact-${locale}-dark.png`) });
      await series.focus();
      await page.keyboard.press('Enter');
      await figure.getByRole('button', { name: labels.chartOnlySeries('Series 1'), exact: true }).focus();
      await page.keyboard.press('Space');
      await expect(series).toHaveAccessibleName(labels.chartSelectedSeries(1, 12));
      await figure.getByRole('button', { name: 'Series 1', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(figure.locator('.doc-chart-output__empty')).toBeVisible();
      await expect(series).toHaveAccessibleName(labels.chartSelectedSeries(0, 12));
      await figure.getByRole('button', { name: labels.chartShowAll }).click();
      await expect(series).toHaveAccessibleName(labels.chartSelectedSeries(12, 12));
      await page.keyboard.press('Escape');
      await expect(series).toBeFocused();
      const data = figure.getByRole('button', { name: labels.showChartData });
      await data.click();
      await expect(figure.getByRole('table')).toContainText(labels.chartVisible);
      const csvPending = page.waitForEvent('download');
      await figure.getByTestId('table-save-csv').click();
      const csvFile = await (await csvPending).path();
      expect(csvFile).not.toBeNull();
      const csv = await readFile(csvFile as string, 'utf8');
      expect(csv).toContain('Series 12');
      expect(csv).toContain(labels.chartVisible);
      await figure.getByRole('button', { name: labels.hideChartData }).click();
      await figure.getByRole('button', { name: labels.chartResetView }).click();
      const exportTrigger = figure.getByRole('button', { name: labels.chartExport, exact: true });
      for (const format of ['SVG', 'PNG']) {
        await exportTrigger.focus();
        await page.keyboard.press('Space');
        const pending = page.waitForEvent('download');
        await figure.getByRole('button', { name: format === 'SVG' ? labels.saveSvg : labels.savePng }).click();
        const download = await pending;
        expect(download.suggestedFilename().replaceAll('_', ' ')).toBe(`Twelve series.${format.toLowerCase()}`);
        const file = await download.path();
        const bytes = await readFile(file as string);
        if (format === 'SVG') expect(bytes.toString()).toContain('<svg');
        else expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        await expect(exportTrigger).toHaveAttribute('aria-expanded', 'false');
        await expect(exportTrigger).toBeFocused();
      }
      if (browserName === 'chromium' && width === 390) {
        await exportTrigger.click();
        expect(
          (
            await new AxeBuilder({ page })
              .include(`[data-testid="${await cell.getAttribute('data-testid')}"] .doc-chart-output`)
              .analyze()
          ).violations
        ).toEqual([]);
        await page.keyboard.press('Escape');
      }
      await geometry(page, figure);
    });
  }
}

test('container breakpoint, small legends, and enlarged text preserve controls and selection', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('http://127.0.0.1:4323/?fixture=compactLegend&width=575');
  const figure = page.locator('.doc-chart-output');
  const trigger = figure.getByRole('button', { name: 'Series (12/12)', exact: true });
  await trigger.click();
  await figure.getByRole('button', { name: 'Only this series: Series 1', exact: true }).click();
  await figure.getByRole('button', { name: 'Series 1', exact: true }).focus();
  await page.locator('main').evaluate((element) => (element.style.width = '576px'));
  await expect(figure.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0);
  await expect(figure.getByRole('button', { name: 'Series 2', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(figure.getByRole('button', { name: 'Show data as a table' })).toBeFocused();
  await expect(figure.getByRole('button', { name: 'Save PNG' })).toBeVisible();
  await expect(figure.locator('.doc-plot canvas')).toBeVisible();
  await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
  await expect(figure.getByRole('button', { name: 'Series (1/12)', exact: true })).toBeVisible();
  await geometry(page, figure);
  await page.goto('http://127.0.0.1:4323/?fixture=mixedXy&width=320');
  await expect(page.getByRole('button', { name: 'Samples', exact: true })).toBeVisible();
  await expect(page.locator('.doc-chart-output__legend button[aria-pressed]')).toHaveCount(3);
});

test('paginated compact legends support touch, stable updates, theme, and a new result', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4323/?fixture=paginatedLegend&width=350');
    const figure = page.locator('.doc-chart-output');
    const series = figure.getByRole('button', { name: /^Series \(/ });
    await series.tap();
    await figure.getByRole('button', { name: 'Next page', exact: true }).tap();
    await figure.getByRole('button', { name: 'Only this series: Series 26', exact: true }).tap();
    await expect(series).toHaveAccessibleName('Series (1/26)');
    await page.getByRole('button', { name: 'Update data', exact: true }).tap();
    await expect(series).toHaveAccessibleName('Series (1/26)');
    await page.getByRole('button', { name: 'Reorder and rename series' }).tap();
    await series.tap();
    await figure.getByRole('button', { name: 'Previous page', exact: true }).tap();
    await expect(figure.getByRole('button', { name: 'Series 26', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(figure.getByRole('button', { name: 'Series 25', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await expect(figure.locator('.doc-plot')).toHaveAttribute('data-chart-theme', 'dark');
    await expect(series).toHaveAccessibleName('Series (1/26)');
    await page.getByRole('button', { name: 'Replace result', exact: true }).tap();
    await expect(series).toHaveAccessibleName('Series (26/26)');
  } finally {
    await context.close();
  }
});

test('a forced PNG failure remains visible after export dismissal and keyboard Tab exits normally', async ({
  page
}) => {
  await page.goto('http://127.0.0.1:4323/?fixture=single&width=320');
  const figure = page.locator('.doc-chart-output');
  const trigger = figure.getByRole('button', { name: 'Export', exact: true });
  await trigger.click();
  await page.keyboard.press('Tab');
  await expect(figure.getByRole('button', { name: 'Save PNG' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(figure.getByRole('button', { name: 'Save SVG' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(figure.locator('.doc-chart-output__viewport')).toBeFocused();
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = function (callback) {
      callback(null);
    };
  });
  await figure.getByRole('button', { name: 'Save PNG' }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(figure.getByRole('alert')).toContainText('Unable to encode chart PNG');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('heading', { name: 'single', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(figure.getByRole('alert')).toBeVisible();
});

test('compact image exports omit hidden geometry while table and CSV retain hidden layers', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=mixedXy&width=350&theme=dark');
  const figure = page.locator('.doc-chart-output');
  await figure.getByRole('button', { name: 'Only this series: Reference', exact: true }).click();
  const viewport = figure.locator('.doc-chart-output__viewport');
  await viewport.focus();
  await page.keyboard.press('+');
  await figure.getByRole('button', { name: 'Reset view', exact: true }).click();
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await expect(figure.locator('.doc-plot')).toHaveAttribute('data-chart-theme', 'light');
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await expect(figure.locator('.doc-plot')).toHaveAttribute('data-chart-theme', 'dark');
  for (const format of ['SVG', 'PNG']) {
    await figure.getByRole('button', { name: 'Export', exact: true }).click();
    const pending = page.waitForEvent('download');
    await figure.getByRole('button', { name: `Save ${format}`, exact: true }).click();
    const file = await (await pending).path();
    const bytes = await readFile(file as string);
    if (format === 'SVG') {
      expect(bytes.toString()).not.toContain('#cc6633');
      expect(bytes.toString()).not.toContain('#6688bb');
      expect(bytes.toString()).toContain('#88bbff');
    } else {
      const counts = await page.evaluate(
        async (src) => {
          const image = new Image();
          image.src = src;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('Canvas context unavailable');
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          return [
            [204, 102, 51],
            [102, 136, 187],
            [136, 187, 255]
          ].map((rgb) => {
            let count = 0;
            for (let i = 0; i < pixels.length; i += 4)
              if (rgb.every((value, channel) => pixels[i + channel] === value)) count++;
            return count;
          });
        },
        `data:image/png;base64,${bytes.toString('base64')}`
      );
      expect(counts[0]).toBe(0);
      expect(counts[1]).toBe(0);
      expect(counts[2]).toBeGreaterThan(0);
    }
  }
  await expect(figure.getByRole('button', { name: 'Samples', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await figure.getByRole('button', { name: 'Show data as a table' }).click();
  await expect(figure.getByRole('table')).toContainText('Samples');
  const pending = page.waitForEvent('download');
  await figure.getByTestId('table-save-csv').click();
  const file = await (await pending).path();
  const csv = await readFile(file as string, 'utf8');
  const hiddenRows = csv.split('\n').filter((row) => row.startsWith('samples,'));
  expect(hiddenRows.length).toBeGreaterThan(0);
  expect(hiddenRows.every((row) => row.trim().endsWith(',false'))).toBe(true);
  expect(
    csv
      .split('\n')
      .filter((row) => row.startsWith('reference,'))
      .every((row) => row.trim().endsWith(',true'))
  ).toBe(true);
});
