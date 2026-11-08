import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('touch picking and pinch zoom use CSS coordinates at mobile width', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'Chromium CDP supplies real multi-touch gestures.');
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4323/scene3d.html');
    const canvas = page.getByTestId('scene3d-canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Scene canvas has no bounds');
    // Independent projection oracle for point b=(1,0,0), centered at (.5,.5,.5).
    const yaw = Math.PI / 6,
      pitch = Math.PI / 9,
      radius = Math.sqrt(0.75);
    const back = -0.5 * Math.sin(yaw) - 0.5 * Math.cos(yaw);
    const x = box.x + box.width / 2 + ((0.5 * Math.cos(yaw) - 0.5 * Math.sin(yaw)) / radius) * box.height * 0.4;
    const y = box.y + box.height / 2 - ((-0.5 * Math.cos(pitch) - back * Math.sin(pitch)) / radius) * box.height * 0.4;
    await page.touchscreen.tap(x, y);
    await expect(page.getByRole('status', { name: 'Selected points' })).toContainText('b:');
    const initial = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
    const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: box.x + 100, y: box.y + 100, id: 1 },
        { x: box.x + 200, y: box.y + 100, id: 2 }
      ]
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: box.x + 70, y: box.y + 100, id: 1 },
        { x: box.x + 230, y: box.y + 100, id: 2 }
      ]
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())).not.toBe(initial);
    await expect(page.getByRole('status', { name: 'Selected points' })).toContainText('b:');
  } finally {
    await context.close();
  }
});

for (const width of [390, 1000]) {
  for (const theme of ['light', 'dark']) {
    test(`scene3d interaction, tables and exports (${width}px, ${theme})`, async ({ page, browserName }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`http://127.0.0.1:4323/scene3d.html?theme=${theme}`);
      const scene = page.getByTestId('scene3d-output');
      await expect(scene).toBeVisible();
      const canvas = scene.getByTestId('scene3d-canvas');
      await expect.poll(() => canvas.evaluate((element) => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
      const image = () => canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
      const initial = await image();
      const view = scene.getByRole('group', { name: 'Tetrahedron' });
      await view.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(image).not.toBe(initial);
      await page.keyboard.press('0');
      await expect.poll(image).toBe(initial);
      const box = await view.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.down();
      await page.mouse.move(box.x + 140, box.y + 120, { steps: 3 });
      await page.mouse.up();
      await expect.poll(image).not.toBe(initial);
      await view.hover();
      await page.mouse.wheel(0, -100);
      await scene.getByRole('button', { name: 'Reset view' }).click();
      await expect.poll(image).toBe(initial);
      await scene.getByText('Show data as tables', { exact: true }).click();
      await scene.getByRole('button', { name: 'Select point a', exact: true }).click();
      await scene.getByRole('button', { name: 'Select point b', exact: true }).click();
      const selection = scene.getByRole('status', { name: 'Selected points' });
      await expect(selection).toContainText('Distance: 1 nm');
      await expect(selection).toContainText('<b>Origin</b>');
      await expect(scene.locator('b')).toHaveCount(0);
      await page.getByRole('button', { name: 'Update scene' }).click();
      await expect(selection).toContainText('Distance: 2 nm');
      await page.getByRole('button', { name: 'Change theme' }).click();
      await expect(selection).toContainText('Distance: 2 nm');
      await scene.getByRole('button', { name: 'Core', exact: true }).click();
      await expect(scene.getByRole('button', { name: 'Core', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(scene.getByRole('button', { name: 'Select point a' })).toBeVisible();
      const pngPromise = page.waitForEvent('download');
      await scene.getByRole('button', { name: 'Save PNG' }).click();
      const png = await pngPromise;
      expect((await readFile((await png.path()) as string)).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      );
      const csvPromise = page.waitForEvent('download');
      await scene.getByTestId('table-save-csv').first().click();
      const csv = await csvPromise;
      expect(await readFile((await csv.path()) as string, 'utf8')).toContain('a,<b>Origin</b>,core,0,0,0');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      if (browserName === 'chromium') {
        const accessibility = await new AxeBuilder({ page })
          .include('.doc-scene3d')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(accessibility.violations).toEqual([]);
      }
      const print = scene.locator('.doc-scene3d__print');
      const printInitial = await print.evaluate((element) => (element as HTMLCanvasElement).toDataURL());
      await view.focus();
      await page.keyboard.press('ArrowRight');
      await expect
        .poll(() => print.evaluate((element) => (element as HTMLCanvasElement).toDataURL()))
        .toBe(printInitial);
      await page.emulateMedia({ media: 'print', reducedMotion: 'reduce' });
      await expect(print).toBeVisible();
      await expect(view).not.toBeVisible();
      await page.emulateMedia({ media: 'screen' });
      await page.getByRole('button', { name: 'Replace scene' }).click();
      await expect(selection).toBeEmpty();
      await page.getByRole('button', { name: 'Toggle mount' }).click();
      await expect(scene).toHaveCount(0);
    });
  }
}

test('scene3d works without Canvas and reports mixed units', async ({ page }) => {
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = () => null;
  });
  await page.goto('http://127.0.0.1:4323/scene3d.html?mixed');
  const scene = page.getByTestId('scene3d-output');
  await scene.getByRole('button', { name: 'Select point a' }).click();
  await scene.getByRole('button', { name: 'Select point b' }).click();
  await expect(scene.getByRole('status', { name: 'Selected points' })).toContainText(
    'distance unavailable: axes use different or undeclared units'
  );
});

test('scene3d lazy loads only when emitted, and Rust reactive updates retain selection', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__scene3d-tetrahedron');
  // Hydration outside the scene cell must not load its viewer.
  const textCell = page.getByTestId('cell-features__rich-output__column-formats');
  await textCell.scrollIntoViewIfNeeded();
  await expect(textCell.locator('xpath=ancestor::astro-island[1]')).not.toHaveAttribute('ssr', '');
  expect(requests.some((url) => /Scene3dOutput/u.test(url))).toBe(false);
  await cell.scrollIntoViewIfNeeded();
  const scene = cell.getByTestId('scene3d-output');
  await scene.getByText('Show data as tables').click();
  await scene.getByRole('button', { name: 'Select point a' }).click();
  await scene.getByRole('button', { name: 'Select point b' }).click();
  await expect(scene.getByRole('status', { name: 'Selected points' })).toContainText('Distance: 1 nm');
  const scale = cell.getByRole('slider', { name: 'Scale' });
  await scale.focus();
  await scale.press('ArrowRight');
  await scale.press('ArrowRight');
  await expect(scene.getByRole('status', { name: 'Selected points' })).toContainText('Distance: 2 nm');
});

test('Python and Haskell helpers render scenes in the built site', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/features/rich-output/');
  for (const [id, title] of [
    ['python-scene3d', 'Python scene'],
    ['haskell-scene3d', 'Haskell scene']
  ]) {
    const cell = page.getByTestId(`cell-features__rich-output__${id}`);
    await cell.scrollIntoViewIfNeeded();
    await expect(cell.locator('xpath=ancestor::astro-island[1]')).not.toHaveAttribute('ssr', '');
    await cell.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(cell.getByRole('figure', { name: title })).toBeVisible({ timeout: 60_000 });
    await expect(cell.getByRole('alert')).toHaveCount(0);
  }
});
