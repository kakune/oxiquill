import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

test('Rust cells run from MDX code fences and redraw plots', async ({ page }) => {
  await page.goto('/notes/numerical-computing/logistic-map/');

  await expect(page.getByRole('heading', { name: 'Logistic Map', exact: true })).toBeVisible();

  await expect(page.getByTestId('run-output')).toContainText('x_120');
  await expect(page.getByTestId('cell-source')).toContainText('doc_rust::logistic_series');

  const chart = page.getByTestId('doc-plot');
  await expect(chart).toBeVisible();
  await expect(chart.locator('canvas')).toHaveCount(1);
  const canvas = chart.locator('canvas');

  const initialStats = await canvasStats(canvas);
  expect(initialStats.width).toBeGreaterThan(100);
  expect(initialStats.height).toBeGreaterThan(100);
  expect(initialStats.inkPixels).toBeGreaterThan(1_000);

  const initialImage = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());

  await page.getByRole('slider', { name: 'r' }).evaluate((input) => {
    const slider = input as HTMLInputElement;
    slider.value = '3.70';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect(page.getByTestId('r-value')).toHaveText('3.70');

  await expect
    .poll(async () =>
      canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
    )
    .not.toEqual(initialImage);

  const updatedImage = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
  expect(updatedImage.length).toBeGreaterThan(1_000);
});

test('Python cells and math rendering are available', async ({ page }) => {
  await page.goto('/interactive-rust/');
  await expect(page.getByRole('heading', { name: 'Interactive Cells' })).toBeVisible();

  await expect(page.getByTestId('cell-interactive-rust__logistic-rust')).toBeVisible();
  await expect(page.getByTestId('cell-interactive-rust__rust-controls')).toBeVisible();
  await expect(page.getByTestId('cell-interactive-rust__rust-multiple-crates')).toBeVisible();
  await expect(page.getByTestId('cell-interactive-rust__python-controls')).toBeVisible();
  await expect(page.getByTestId('cell-interactive-rust__logistic-rust').locator('[data-testid="cell-source"] .shiki')).toBeVisible();
  await expect(page.getByTestId('cell-interactive-rust__python-controls').locator('[data-testid="cell-source"] .shiki')).toBeVisible();

  const rustControls = page.getByTestId('cell-interactive-rust__rust-controls');
  await expect(rustControls.getByTestId('run-output')).toContainText('score = 19');
  await rustControls.getByLabel('operation').selectOption('triple');
  await rustControls.getByLabel('include bonus').uncheck();
  await rustControls.getByLabel('verbose').check();
  await expect(rustControls.getByTestId('run-output')).toContainText('style = verbose');
  await expect(rustControls.getByTestId('run-output')).toContainText('score = 21');

  const multipleCrates = page.getByTestId('cell-interactive-rust__rust-multiple-crates');
  await expect(multipleCrates.getByTestId('run-output')).toContainText('final step: 8');
  await expect(multipleCrates.getByTestId('run-output')).toContainText(
    'compact output keeps only the essentials'
  );
  await multipleCrates.getByLabel('verbose').check();
  await expect(multipleCrates.getByTestId('run-output')).toContainText(
    'verbose output includes explanatory labels'
  );

  await expect(page.getByTestId('run-output').filter({ hasText: 'SAMPLE: mean = 7.5' })).toBeVisible({
    timeout: 45_000
  });

  await page.getByLabel('method').selectOption('sum');
  await expect(page.getByTestId('run-output').filter({ hasText: 'SAMPLE: sum = 30' })).toBeVisible();

  await page.goto('/math/');
  await expect(page.getByRole('heading', { name: 'Math', exact: true })).toBeVisible();
  await expect(page.locator('.katex').first()).toBeVisible();
  expect(await page.locator('.katex').count()).toBeGreaterThan(3);
});

test('theme note and Mermaid examples are available without author-side TSX imports', async ({ page }) => {
  await page.goto('/notes/rust-basics/ownership/');
  await expect(page.getByRole('heading', { name: 'Ownership' })).toBeVisible();

  await page.goto('/notes/numerical-computing/logistic-map/');
  await expect(page.getByRole('heading', { name: 'Logistic Map', exact: true })).toBeVisible();

  await page.goto('/interactive-rust/');
  await expect(page.locator('text=import RunExample')).toHaveCount(0);

  await page.goto('/mermaid/');
  await expect(page.getByRole('heading', { name: 'Mermaid' })).toBeVisible();
  const diagrams = page.getByTestId('mermaid-diagram');
  await expect(diagrams).toHaveCount(3);
  await expect(diagrams.first().locator('svg')).toBeVisible();
  await expect(diagrams.nth(1).locator('svg')).toBeVisible();
  await expect(diagrams.nth(2).locator('svg')).toBeVisible();
});

test('localized pages and media examples are available', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Oxiquill' })).toBeVisible();

  await page.goto('/ja/');
  await expect(page.getByRole('heading', { name: 'Oxiquill' })).toBeVisible();

  await page.goto('/media/');
  await expect(page.getByRole('heading', { name: 'Media', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'PNG sample with color bands' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'JPEG sample with a grid and gradient' })).toBeVisible();
  await expect(page.locator('iframe.media-frame')).toHaveAttribute('src', '/media/examples/sample.pdf');

  await page.goto('/ja/interactive-rust/');
  await expect(page.getByRole('heading', { name: '実行可能セル' })).toBeVisible();
  await expect(page.getByTestId('cell-ja__interactive-rust__rust-controls').getByRole('button', { name: 'コードを隠す' })).toBeVisible();
});

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
      const [red, green, blue, alpha] = [
        pixels[index],
        pixels[index + 1],
        pixels[index + 2],
        pixels[index + 3]
      ];

      if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) {
        inkPixels += 1;
      }
    }

    return { height: canvasElement.height, inkPixels, width: canvasElement.width };
  });
}
