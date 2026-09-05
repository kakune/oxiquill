import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

test('desktop sidebar toggle collapses, expands, and persists across navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/features/math/');

  const sidebar = page.locator('#starlight__sidebar');
  const mainFrame = page.locator('.main-frame');
  const contentContainer = page.locator('.content-panel .sl-container').first();
  const toggle = page.locator('starlight-sidebar-toggle button');

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse sidebar');
  await expect(sidebar).toBeVisible();
  const expandedContentWidth = await elementWidth(contentContainer);
  expect(await sidebarPadding(mainFrame)).toBeGreaterThan(100);

  await toggle.click();

  await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Expand sidebar');
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true');
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect(sidebar).not.toBeVisible();
  await expect.poll(() => sidebarPadding(mainFrame)).toBeLessThan(1);
  await expect.poll(() => elementWidth(contentContainer)).toBeGreaterThan(expandedContentWidth + 100);
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-sidebar-collapsed'))).toBe('true');

  await page.goto('/features/diagrams/');

  const persistedToggle = page.locator('starlight-sidebar-toggle button');
  await expect(page.locator('html')).toHaveAttribute('data-sidebar-collapsed', '');
  await expect(persistedToggle).toBeVisible();
  await expect(persistedToggle).toHaveAttribute('aria-label', 'Expand sidebar');
  await expect(page.locator('#starlight__sidebar')).not.toBeVisible();

  await persistedToggle.evaluate((element) => {
    const toggleElement = element.closest('starlight-sidebar-toggle');
    const parent = toggleElement?.parentElement;
    if (toggleElement && parent) parent.append(toggleElement);
  });
  await persistedToggle.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-collapsed', '');

  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-collapsed', '');
  await expect(persistedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(persistedToggle).toHaveAttribute('aria-label', 'Collapse sidebar');
  await expect(page.locator('#starlight__sidebar')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-sidebar-collapsed'))).toBeNull();
});

test('sidebar labels use the primary Japanese language subtag', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ja/features/math/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
  await expect(page.locator('starlight-sidebar-toggle button')).toHaveAttribute('aria-label', 'サイドバーを折りたたむ');
});

test('desktop sidebar preference does not affect the mobile menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/features/math/');
  await page.evaluate(() => sessionStorage.setItem('oxiquill-sidebar-collapsed', 'true'));
  await page.reload();

  const sidebar = page.locator('#starlight__sidebar');
  const mobileMenu = page.getByRole('button', { name: 'Menu' });

  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-collapsed', '');
  await expect(page.getByRole('button', { name: /sidebar/i })).toHaveCount(0);
  await expect(mobileMenu).toBeVisible();
  await expect(sidebar).not.toBeVisible();

  await mobileMenu.click();
  await expect(sidebar).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-mobile-menu-expanded', '');

  await mobileMenu.click();
  await expect(sidebar).not.toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-mobile-menu-expanded', '');
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-sidebar-collapsed'))).toBe('true');
});

test('desktop table of contents collapses, releases its column, and persists independently', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/features/math/');

  const tableOfContents = page.locator('#starlight__right-sidebar');
  const mainPane = page.locator('.two-column-content > .main-pane');
  const contentContainer = page.locator('.content-panel .sl-container').first();
  const toggle = page.locator('starlight-table-of-contents-toggle button');
  const tableOfContentsLink = tableOfContents.getByRole('link').first();

  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-controls', 'starlight__right-sidebar');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Collapse table of contents');
  await expect(tableOfContents).toBeVisible();
  const expandedMainWidth = await elementWidth(mainPane);
  const expandedContentWidth = await elementWidth(contentContainer);

  await tableOfContentsLink.focus();
  await toggle.evaluate((element) => (element as HTMLButtonElement).click());

  await expect(toggle).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-table-of-contents-collapsed', '');
  await expect(page.locator('html')).not.toHaveAttribute('data-sidebar-collapsed', '');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toHaveAttribute('aria-label', 'Expand table of contents');
  await expect(tableOfContents).toHaveAttribute('aria-hidden', 'true');
  await expect(tableOfContents).toHaveAttribute('inert', '');
  await expect(tableOfContents).not.toBeVisible();
  await expect.poll(() => elementWidth(mainPane)).toBeGreaterThan(expandedMainWidth + 100);
  await expect.poll(() => elementWidth(contentContainer)).toBeGreaterThan(expandedContentWidth + 100);
  expect(await horizontalOverflow(page)).toBeLessThan(1);
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-table-of-contents-collapsed'))).toBe('true');
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-sidebar-collapsed'))).toBeNull();

  await page.goto('/features/diagrams/');

  const persistedToggle = page.locator('starlight-table-of-contents-toggle button');
  await expect(page.locator('html')).toHaveAttribute('data-table-of-contents-collapsed', '');
  await expect(persistedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#starlight__right-sidebar')).not.toBeVisible();

  await persistedToggle.evaluate((element) => {
    const toggleElement = element.closest('starlight-table-of-contents-toggle');
    const parent = toggleElement?.parentElement;
    if (toggleElement && parent) parent.append(toggleElement);
  });
  await persistedToggle.focus();
  await persistedToggle.press('Enter');

  await expect(persistedToggle).toBeFocused();
  await expect(page.locator('html')).not.toHaveAttribute('data-table-of-contents-collapsed', '');
  await expect(persistedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#starlight__right-sidebar')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-table-of-contents-collapsed'))).toBeNull();
});

test('desktop table-of-contents labels use the primary Japanese language subtag', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/ja/features/math/');

  await expect(page.locator('html')).toHaveAttribute('lang', 'ja-JP');
  await expect(page.locator('starlight-table-of-contents-toggle button')).toHaveAttribute(
    'aria-label',
    '目次を折りたたむ'
  );
});

test('desktop table-of-contents preference does not affect the mobile disclosure', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/features/math/');
  await page.evaluate(() => sessionStorage.setItem('oxiquill-table-of-contents-collapsed', 'true'));
  await page.reload();

  const tableOfContents = page.locator('#starlight__right-sidebar');
  const desktopToggle = page.locator('starlight-table-of-contents-toggle button');
  const mobileDisclosure = page.locator('#starlight__mobile-toc summary');

  await expect(page.locator('html')).not.toHaveAttribute('data-table-of-contents-collapsed', '');
  await expect(desktopToggle).not.toBeVisible();
  await expect(tableOfContents).not.toHaveAttribute('aria-hidden');
  await expect(tableOfContents).not.toHaveAttribute('inert');
  await expect(mobileDisclosure).toBeVisible();
  await mobileDisclosure.press('Enter');
  await expect(page.locator('#starlight__mobile-toc')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => sessionStorage.getItem('oxiquill-table-of-contents-collapsed'))).toBe('true');
});

test('table-of-contents toggle stays absent on disabled and splash pages', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/features/math/');
  await page.evaluate(() => sessionStorage.setItem('oxiquill-table-of-contents-collapsed', 'true'));

  for (const path of ['/tests/no-table-of-contents/', '/tests/splash/']) {
    await page.goto(path);
    await expect(page.locator('html')).not.toHaveAttribute('data-has-toc', '');
    await expect(page.locator('html')).not.toHaveAttribute('data-table-of-contents-collapsed', '');
    await expect(page.locator('starlight-table-of-contents-toggle')).toHaveCount(0);
    await expect(page.locator('#starlight__right-sidebar')).toHaveCount(0);
  }
});

test('table-of-contents collapse uses logical positioning and does not constrain print output', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/features/math/');

  const toggle = page.locator('starlight-table-of-contents-toggle button');
  const ltrPosition = await inlinePosition(toggle);
  expect(ltrPosition.x).toBeGreaterThan(640);

  await page.locator('html').evaluate((element) => {
    (element as HTMLElement).dir = 'rtl';
  });
  const rtlPosition = await inlinePosition(toggle);
  expect(rtlPosition.x).toBeLessThan(640);

  await toggle.click();
  await page.emulateMedia({ media: 'print' });

  await expect(toggle).not.toBeVisible();
  await expect(page.locator('#starlight__right-sidebar')).not.toBeVisible();
  expect(await elementWidth(page.locator('.two-column-content > .main-pane'))).toBeGreaterThan(1200);
  expect(await horizontalOverflow(page)).toBeLessThan(1);
});

test('static pages do not reference optional browser runtimes', async ({ page }) => {
  const requests = captureRequestPaths(page);

  await page.goto('/guides/licensing/', { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: 'Licensing', exact: true })).toBeVisible();
  await expect(page.locator('astro-island[component-url*="InteractiveCell"]')).toHaveCount(0);
  await expect(page.locator('astro-island[component-url*="MermaidDiagram"]')).toHaveCount(0);
  expect(requests.filter(isOptionalRuntimeRequest)).toEqual([]);
});

test('off-screen reactive cells wait for visible hydration', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 240 });
  const requests = captureRequestPaths(page);

  await page.goto('/features/interactive-cells/', { waitUntil: 'networkidle' });

  const cell = page.getByTestId('cell-features__interactive-cells__logistic-rust');
  const cellBounds = await cell.boundingBox();
  expect(cellBounds?.y).toBeGreaterThan(240);
  expect(requests.some((request) => request.includes('/rust-worker-'))).toBe(false);
  expect(requests.some((request) => request.includes('/rust-wasm/'))).toBe(false);

  await cell.scrollIntoViewIfNeeded();
  await expect(cell.getByTestId('run-output')).toContainText('n=0 x=0.200000');

  expect(requests.some((request) => request.includes('/rust-worker-'))).toBe(true);
  expect(requests.some((request) => request.includes('/rust-wasm/'))).toBe(true);
  expect(requests.some((request) => request.includes('/python-worker-'))).toBe(false);
  expect(requests.some((request) => request.includes('/haskell-worker-'))).toBe(false);
});

test('button, reactive, and autorun cells follow their execution contracts', async ({ page }) => {
  await captureWorkerMessages(page);
  await page.goto('/features/interactive-cells/');

  const button = page.getByTestId('cell-features__interactive-cells__run-mode-button');
  await hydrateCell(button);
  await expect(button.getByLabel('Input value')).toBeVisible();
  await expect(button.getByRole('button', { name: 'Run' })).toBeVisible();
  await page.waitForTimeout(200);
  expect(await workerMessagesForCell(page, 'features__interactive-cells__run-mode-button')).toHaveLength(0);

  await button.getByRole('button', { name: 'Run' }).click();
  await expect(button.getByTestId('run-output')).toContainText('button value = 3');

  const reactive = page.getByTestId('cell-features__interactive-cells__rust-controls');
  await hydrateCell(reactive);
  await expect(reactive.getByLabel('operation')).toBeVisible();
  await expect(reactive.getByRole('button', { name: 'Run' })).toHaveCount(0);
  await expect(reactive.getByTestId('run-output')).toContainText('score = 19');

  const autorun = page.getByTestId('cell-features__interactive-cells__run-mode-autorun');
  await hydrateCell(autorun);
  await expect(autorun.locator('input, select, textarea')).toHaveCount(0);
  await expect(autorun.getByRole('button', { name: 'Run' })).toHaveCount(0);
  await expect(autorun.getByTestId('run-output')).toContainText('autorun ready');
  expect(await workerMessagesForCell(page, 'features__interactive-cells__run-mode-autorun')).toHaveLength(1);
});

test('rapid reactive input keeps only the final replacement request', async ({ page }) => {
  test.setTimeout(120_000);
  await captureWorkerMessages(page);
  await page.goto('/features/interactive-cells/');

  const python = page.getByTestId('cell-features__interactive-cells__python-controls');
  await hydrateCell(python);
  await expect.poll(() => workerMessagesForCell(page, 'features__interactive-cells__python-controls')).toHaveLength(1);

  await python.getByLabel('label').evaluate((element) => {
    const input = element as HTMLInputElement;
    for (let index = 0; index < 10; index += 1) {
      input.value = `rapid-${index}`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await expect(python.getByTestId('run-output')).toContainText('RAPID-9: mean = 7.5', { timeout: 90_000 });
  const requests = await workerMessagesForCell(page, 'features__interactive-cells__python-controls');
  expect(requests).toHaveLength(2);
  expect(requests[1]?.inputs).toMatchObject({ label: 'rapid-9' });
});

test('text-only Haskell cells do not load chart or unrelated runtimes', async ({ page }) => {
  const requests = captureRequestPaths(page);

  await page.goto('/samples/haskell-series/');
  const cell = page.getByTestId('cell-samples__haskell-series__haskell-series-note');
  await cell.scrollIntoViewIfNeeded();
  await expect(cell.getByTestId('run-output')).toContainText('series: 2, 6, 12, 20, 30, 42');

  expect(requests.some((request) => request.includes('/haskell-worker-'))).toBe(true);
  expect(requests.some((request) => request.includes('/haskell-wasm/'))).toBe(true);
  expect(requests.some((request) => request.includes('/ChartOutput.'))).toBe(false);
  expect(requests.some((request) => request.includes('/rust-worker-'))).toBe(false);
  expect(requests.some((request) => request.includes('/python-worker-'))).toBe(false);
  expect(requests.some((request) => request.includes('/pyodide/'))).toBe(false);
});

test('Rust cells run from MDX code fences and redraw plots', async ({ page }) => {
  await page.addInitScript(`
    globalThis.__heldChartResults = [];
    const add = Worker.prototype.addEventListener;
    Worker.prototype.addEventListener = function (type, listener, ...rest) {
      const worker = this;
      return Reflect.apply(add, this, [type, type === 'message' ? function (event) {
        const deliver = () => listener.call(worker, event);
        if (globalThis.__holdChartResults) globalThis.__heldChartResults.push(deliver);
        else deliver();
      } : listener, ...rest]);
    };
  `);
  await page.goto('/samples/logistic-map/');

  await expect(page.getByRole('heading', { name: 'Logistic Map', exact: true })).toBeVisible();

  const cell = page.getByTestId('cell-samples__logistic-map__logistic-map-note');
  await hydrateCell(cell);
  await expect(cell.getByTestId('run-output')).toContainText('x_120');
  await expect(cell.getByTestId('cell-source')).toContainText('doc_rust::logistic_series');

  const chart = cell.getByTestId('doc-plot');
  await expect(chart).toBeVisible();
  await expect(chart.locator('canvas')).toHaveCount(1);
  const canvas = chart.locator('canvas');
  const originalCanvas = await canvas.elementHandle();
  // Let the initial 180ms animation finish before comparing the retained image.
  await page.waitForTimeout(250);

  const initialStats = await canvasStats(canvas);
  expect(initialStats.width).toBeGreaterThan(100);
  expect(initialStats.height).toBeGreaterThan(100);
  expect(initialStats.inkPixels).toBeGreaterThan(1_000);

  const initialImage = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  await page.evaluate('globalThis.__holdChartResults = true');

  await page.getByRole('slider', { name: 'r' }).evaluate((input) => {
    const slider = input as HTMLInputElement;
    slider.value = '3.70';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.getByTestId('r-value')).toHaveText('3.70');
  await expect.poll(() => page.evaluate('globalThis.__heldChartResults.length')).toBe(1);
  await expect(cell.locator('.doc-cell__output-region')).toHaveAttribute('aria-busy', 'true');
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
  expect(await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).toBe(initialImage);
  await expect(cell.locator('.doc-cell__updating')).toHaveAttribute('aria-hidden', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(chart).toHaveAttribute('data-chart-motion', 'reduced');
  expect(await cell.locator('.doc-cell__updating').evaluate((node) => getComputedStyle(node).animationName)).toBe(
    'none'
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(chart).toHaveAttribute('data-chart-motion', 'full');
  await page.evaluate(
    'globalThis.__holdChartResults = false; globalThis.__heldChartResults.splice(0).forEach(deliver => deliver())'
  );

  await expect
    .poll(async () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
    .not.toEqual(initialImage);

  const updatedImage = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  expect(updatedImage.length).toBeGreaterThan(1_000);
  expect(await canvas.evaluate((node, previous) => node === previous, originalCanvas)).toBe(true);
});

test('interactive cells and math rendering are available', async ({ page }) => {
  await page.goto('/features/interactive-cells/');
  await expect(page.getByRole('heading', { name: 'Interactive Cells' })).toBeVisible();

  await expect(page.getByTestId('cell-features__interactive-cells__logistic-rust')).toBeVisible();
  await expect(page.getByTestId('cell-features__interactive-cells__rust-controls')).toBeVisible();
  await expect(page.getByTestId('cell-features__interactive-cells__rust-multiple-crates')).toBeVisible();
  await expect(page.getByTestId('cell-features__interactive-cells__python-controls')).toBeVisible();
  await expect(page.getByTestId('cell-features__interactive-cells__haskell-controls')).toBeVisible();
  await expect(
    page.getByTestId('cell-features__interactive-cells__logistic-rust').locator('[data-testid="cell-source"] .shiki')
  ).toBeVisible();
  await expect(
    page.getByTestId('cell-features__interactive-cells__python-controls').locator('[data-testid="cell-source"] .shiki')
  ).toBeVisible();
  await expect(
    page.getByTestId('cell-features__interactive-cells__haskell-controls').locator('[data-testid="cell-source"] .shiki')
  ).toBeVisible();

  const rustControls = page.getByTestId('cell-features__interactive-cells__rust-controls');
  await hydrateCell(rustControls);
  await expect(rustControls.getByTestId('run-output')).toContainText('score = 19');
  await rustControls.getByLabel('operation').selectOption('triple');
  await rustControls.getByLabel('include bonus').uncheck();
  await rustControls.getByLabel('verbose').check();
  await expect(rustControls.getByTestId('run-output')).toContainText('style = verbose');
  await expect(rustControls.getByTestId('run-output')).toContainText('score = 21');

  const multipleCrates = page.getByTestId('cell-features__interactive-cells__rust-multiple-crates');
  await hydrateCell(multipleCrates);
  await expect(multipleCrates.getByTestId('run-output')).toContainText('final step: 8');
  await expect(multipleCrates.getByTestId('run-output')).toContainText('compact output keeps only the essentials');
  await multipleCrates.getByLabel('verbose').check();
  await expect(multipleCrates.getByTestId('run-output')).toContainText('verbose output includes explanatory labels');

  const python = page.getByTestId('cell-features__interactive-cells__python-controls');
  await hydrateCell(python);
  await expect(python.getByTestId('run-output')).toContainText('SAMPLE: mean = 7.5', {
    timeout: 45_000
  });

  await python.getByLabel('method').selectOption('sum');
  await expect(python.getByTestId('run-output')).toContainText('SAMPLE: sum = 30');

  const haskell = page.getByTestId('cell-features__interactive-cells__haskell-controls');
  await hydrateCell(haskell);
  await expect(haskell.getByTestId('run-output')).toContainText('sample: 9, 36, 81, 144', {
    timeout: 45_000
  });
  await haskell.getByLabel('include squares').uncheck();
  await expect(haskell.getByTestId('run-output')).toContainText('total = 30');

  await page.goto('/features/math/');
  await expect(page.getByRole('heading', { name: 'Math', exact: true })).toBeVisible();
  await expect(page.locator('.katex').first()).toBeVisible();
  expect(await page.locator('.katex').count()).toBeGreaterThan(3);
});

test('rich output examples render browser-visible artifacts', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/features/rich-output/');
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });

  const rust = page.getByTestId('cell-features__rich-output__rust-rich-outputs');
  await hydrateCell(rust);
  await rust.getByRole('button', { name: 'Run' }).click();

  await expect(rust.getByTestId('value-output').filter({ hasText: '"status": "ok"' })).toBeVisible();
  await expect(rust.getByTestId('table-output')).toHaveCount(2);

  const explicitTable = rust.getByTestId('table-output').nth(1);
  await explicitTable.getByRole('button', { name: 'Score' }).click();
  await expect(explicitTable.getByRole('columnheader', { name: 'Score' })).toHaveAttribute('aria-sort', 'ascending');

  const rustCharts = rust.getByTestId('doc-plot');
  await expect(rustCharts).toHaveCount(2);
  const rustBarChart = rustCharts.first();
  const rustHeatmap = rustCharts.nth(1);
  await expect(rustBarChart.locator('canvas')).toHaveCount(1);
  await expect(rustHeatmap.locator('canvas').first()).toBeVisible();
  await expect(rustBarChart).toHaveAttribute('data-chart-theme', 'light');
  await expect(rustHeatmap).toHaveAttribute('data-chart-theme', 'light');
  await expect.poll(() => canvasColorPixels(rustBarChart.locator('canvas'), [124, 58, 237])).toBeGreaterThan(500);
  expect((await canvasStats(rustBarChart.locator('canvas'))).inkPixels).toBeGreaterThan(1_000);
  const heatmapCanvases = rustHeatmap.locator('canvas');
  const heatmapStats = await Promise.all(
    Array.from({ length: await heatmapCanvases.count() }, (_, index) => canvasStats(heatmapCanvases.nth(index)))
  );
  expect(Math.max(...heatmapStats.map(({ inkPixels }) => inkPixels))).toBeGreaterThan(500);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await expect(rustBarChart).toHaveAttribute('data-chart-theme', 'dark');
  await expect(rustHeatmap).toHaveAttribute('data-chart-theme', 'dark');
  await expect.poll(() => canvasColorPixels(rustBarChart.locator('canvas'), [196, 181, 253])).toBeGreaterThan(500);
  await expect(rustBarChart.locator('canvas')).toHaveCount(1);
  await expect(rustHeatmap.locator('canvas').first()).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await expect(rustBarChart).toHaveAttribute('data-chart-theme', 'light');
  await expect(rustHeatmap).toHaveAttribute('data-chart-theme', 'light');
  await expect(rust.getByTestId('image-output')).toHaveAttribute('src', /data:image\/svg\+xml/);
  const htmlOutput = rust.getByTestId('html-output');
  await expect(htmlOutput).toHaveAttribute('sandbox', '');
  await expect(htmlOutput).toHaveAttribute('csp', /default-src 'none'/);
  await expect(htmlOutput).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(htmlOutput).toHaveAttribute('srcdoc', /default-src 'none'/);
  await expect(htmlOutput).toHaveAttribute('srcdoc', /Sandboxed HTML/);

  const privacyProbeResponses: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('__oxiquill_html_privacy_probe__')) privacyProbeResponses.push(response.url());
  });
  await htmlOutput.evaluate((element) => {
    const iframe = element as HTMLIFrameElement;
    iframe.srcdoc = (iframe.srcdoc ?? '').replace(
      '</body>',
      `<script>
        document.body.dataset.scriptExecuted = 'true';
        parent.document.documentElement.dataset.htmlArtifactParentRead = document.title;
        fetch('/__oxiquill_html_privacy_probe__/script');
      </script>
      <img src="/__oxiquill_html_privacy_probe__/image" alt="">
      <div style="background-image: url('/__oxiquill_html_privacy_probe__/style')">probe</div>
      </body>`
    );
  });
  const htmlFrame = htmlOutput.contentFrame();
  await expect(htmlFrame.locator('body')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(htmlFrame.locator('body')).not.toHaveAttribute('data-script-executed', 'true');
  expect(await page.locator('html').getAttribute('data-html-artifact-parent-read')).toBeNull();
  expect(privacyProbeResponses).toEqual([]);

  const python = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await hydrateCell(python);
  await python.getByRole('button', { name: 'Run' }).click();

  await expect(python.getByTestId('table-output')).toBeVisible({ timeout: 150_000 });
  await expect(python.getByTestId('table-output').locator('caption')).toHaveText('Pandas table');
  await expect(python.getByTestId('value-output').filter({ hasText: '"status": "ok"' })).toBeVisible();
  await expect(python.getByTestId('html-output')).toHaveAttribute('sandbox', '');
  await expect(python.getByTestId('html-output')).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(python.getByTestId('html-output')).toHaveAttribute('srcdoc', /Sandboxed HTML/);
  await expect(python.getByTestId('image-output')).toHaveAttribute('src', /data:image\/svg\+xml/);
});

test('chart rendering recovers after a transient chunk load failure', async ({ browserName, page }) => {
  test.skip(
    browserName !== 'chromium',
    'One real-browser recovery path is sufficient for the chunk failure regression.'
  );
  test.setTimeout(180_000);
  let failedOnce = false;
  await page.route('**/*', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const referrer = request.headers()['referer'] ?? '';
    if (
      !failedOnce &&
      pathname.includes('/ChartOutput.') &&
      pathname.endsWith('.js') &&
      referrer.includes('/InteractiveCell.')
    ) {
      failedOnce = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });

  await page.goto('/features/rich-output/');
  const rust = page.getByTestId('cell-features__rich-output__rust-rich-outputs');
  await hydrateCell(rust);
  await rust.getByRole('button', { name: 'Run' }).click();
  const alerts = rust.getByRole('alert');
  const charts = rust.getByTestId('doc-plot');
  await expect.poll(async () => (await alerts.count()) + (await charts.count())).toBe(2);
  const failedChartCount = await alerts.count();
  expect(failedChartCount).toBeGreaterThan(0);
  await expect(alerts.first()).toContainText('Chart renderer could not be loaded');
  expect(failedOnce).toBe(true);

  const retryButtons = rust.getByRole('button', { name: 'Retry chart rendering' });
  await expect(retryButtons).toHaveCount(failedChartCount);
  for (let remaining = failedChartCount; remaining > 0; remaining -= 1) {
    await retryButtons.first().click();
    await expect(retryButtons).toHaveCount(remaining - 1);
  }
  await expect(charts).toHaveCount(2);
  await expect(charts.first().locator('canvas').first()).toBeVisible();
  await expect(charts.nth(1).locator('canvas').first()).toBeVisible();
});

test('theme note and Mermaid examples are available without author-side TSX imports', async ({ page }) => {
  await page.goto('/samples/rust-ownership/');
  await expect(page.getByRole('heading', { name: 'Rust Ownership' })).toBeVisible();

  await page.goto('/samples/logistic-map/');
  await expect(page.getByRole('heading', { name: 'Logistic Map', exact: true })).toBeVisible();

  await page.goto('/samples/haskell-series/');
  await expect(page.getByRole('heading', { name: 'Haskell Series', exact: true })).toBeVisible();
  await expect(page.getByTestId('cell-samples__haskell-series__haskell-series-note')).toBeVisible();

  await page.goto('/features/interactive-cells/');
  await expect(page.locator('text=import RunExample')).toHaveCount(0);

  await page.goto('/features/diagrams/');
  await expect(page.getByRole('heading', { name: 'Diagrams' })).toBeVisible();
  const diagrams = page.getByTestId('mermaid-diagram');
  await expect(diagrams).toHaveCount(3);
  await expect(diagrams.first().locator('svg')).toBeVisible({ timeout: 30_000 });
  await expect(diagrams.nth(1).locator('svg')).toBeVisible();
  await expect(diagrams.nth(2).locator('svg')).toBeVisible();

  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });

  await expect(diagrams.first().locator('svg')).toBeVisible();
  await expect(diagrams.nth(1).locator('svg')).toBeVisible();
  await expect(diagrams.nth(2).locator('svg')).toBeVisible();
});

test('localized pages and media examples are available', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Oxiquill' })).toBeVisible();

  await page.goto('/ja/');
  await expect(page.getByRole('heading', { name: 'Oxiquill' })).toBeVisible();

  await page.goto('/features/media/');
  await expect(page.getByRole('heading', { name: 'Media', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PNG sample with color bands' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'JPEG sample with a grid and gradient' })).toBeVisible();
  await expect(page.locator('iframe.media-frame')).toHaveAttribute('src', '/media/examples/sample.pdf');

  await page.goto('/ja/features/interactive-cells/');
  await expect(page.getByRole('heading', { name: '実行可能セル' })).toBeVisible();
  const localizedCell = page.getByTestId('cell-ja__features__interactive-cells__rust-controls');
  await hydrateCell(localizedCell);
  await expect(localizedCell.getByRole('button', { name: 'コードを隠す' })).toBeVisible();
});

test('the production site serves the custom 404 page', async ({ page }) => {
  const response = await page.goto('/this-route-does-not-exist/');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page Not Found', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Go to the English documentation home' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: '日本語ドキュメントのトップへ' })).toHaveAttribute('href', '/ja/');
});

async function sidebarPadding(mainFrame: Locator): Promise<number> {
  return mainFrame.evaluate((element) => parseFloat(getComputedStyle(element).paddingInlineStart));
}

async function elementWidth(locator: Locator): Promise<number> {
  return locator.evaluate((element) => element.getBoundingClientRect().width);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function inlinePosition(locator: Locator): Promise<{ x: number; width: number }> {
  return locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return { width: bounds.width, x: bounds.x };
  });
}

async function canvasStats(canvas: Locator): Promise<{
  height: number;
  inkPixels: number;
  width: number;
}> {
  return canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    const context = canvasElement.getContext('2d');

    if (!context) {
      return { height: canvasElement.height, inkPixels: 0, width: canvasElement.width };
    }

    const pixels = context.getImageData(0, 0, canvasElement.width, canvasElement.height).data;
    let inkPixels = 0;

    for (let index = 0; index < pixels.length; index += 4) {
      const [red, green, blue, alpha] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];

      if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) {
        inkPixels += 1;
      }
    }

    return { height: canvasElement.height, inkPixels, width: canvasElement.width };
  });
}

async function canvasColorPixels(canvas: Locator, rgb: number[]): Promise<number> {
  return canvas.evaluate((element, color) => {
    const canvas = element as HTMLCanvasElement;
    const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] > 200 && color.every((channel, offset) => Math.abs(data[index + offset] - channel) < 3))
        count += 1;
    }
    return count;
  }, rgb);
}

function captureRequestPaths(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(new URL(request.url()).pathname);
  });
  return requests;
}

function isOptionalRuntimeRequest(requestPath: string): boolean {
  return [
    '/InteractiveCell.',
    '/MermaidDiagram.',
    '/ChartOutput.',
    '/rust-worker-',
    '/python-worker-',
    '/haskell-worker-',
    '/mermaid.core.',
    '/oxiquill/pyodide/',
    '/oxiquill/rust-wasm/',
    '/oxiquill/haskell-wasm/'
  ].some((fragment) => requestPath.includes(fragment));
}

async function hydrateCell(cell: Locator): Promise<void> {
  await cell.scrollIntoViewIfNeeded();
  const island = cell.locator('xpath=ancestor::astro-island');
  await expect.poll(() => island.getAttribute('ssr')).toBeNull();
}

async function captureWorkerMessages(page: Page): Promise<void> {
  await page.addInitScript(`
    globalThis.__oxiquillWorkerMessages = [];
    const originalPostMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      globalThis.__oxiquillWorkerMessages.push(structuredClone(message));
      return Reflect.apply(originalPostMessage, this, [message, ...rest]);
    };
  `);
}

async function workerMessagesForCell(
  page: Page,
  cellId: string
): Promise<Array<{ cellId?: string; inputs?: Record<string, unknown> }>> {
  return page.evaluate((requestedCellId) => {
    const messages = Reflect.get(globalThis, '__oxiquillWorkerMessages') as Array<{
      cellId?: string;
      inputs?: Record<string, unknown>;
    }>;
    return messages.filter((message) => message.cellId === requestedCellId);
  }, cellId);
}
