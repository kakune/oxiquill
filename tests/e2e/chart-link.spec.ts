import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function range(page: Page, id: string) {
  return page.locator(`#${id} .doc-plot`).evaluate((plot) => {
    const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
    const option = chart?.getOption() as { dataZoom?: { startValue: number; endValue: number }[] };
    return [option?.dataZoom?.[0].startValue, option?.dataZoom?.[0].endValue];
  });
}

async function zoom(page: Page, start: number, end: number) {
  await page.locator('#source .doc-plot').evaluate(
    (plot, [startValue, endValue]) => {
      window.galleryECharts
        .getInstanceByDom(plot as HTMLElement)
        ?.dispatchAction({ type: 'dataZoom', startValue, endValue });
    },
    [start, end]
  );
}

for (const axis of ['value', 'time', 'log']) {
  test(`links domain zoom, reset, and keyboard on ${axis} axes`, async ({ page }) => {
    const x = (value: number) =>
      axis === 'time' ? Date.UTC(2026, 0, 1) + value * 1000 : axis === 'log' ? value + 1 : value;
    await page.goto(`http://127.0.0.1:4323/?linked&axis=${axis}`);
    await expect(page.locator('canvas')).toHaveCount(4);
    await zoom(page, x(20), x(80));
    await expect.poll(() => range(page, 'peer')).toEqual([x(25), x(80)]);
    expect(await range(page, 'other')).toEqual([x(0), x(100)]);
    expect(await range(page, 'disjoint')).toEqual([x(200), x(300)]);
    await expect(page.locator('#disjoint [role=status]')).toHaveText('This chart has no data in the selected range.');
    await page.getByRole('button', { name: 'Add late peer' }).click();
    await expect.poll(() => range(page, 'late')).toEqual([x(20), x(80)]);
    const before = await range(page, 'source');
    await page.getByRole('button', { name: 'Update linked data' }).click();
    await expect(page.locator('#source .doc-chart-output__summary')).toContainText('1–11');
    expect(await range(page, 'source')).toEqual(before);
    const wrapper = page.locator('#source .doc-chart-output__viewport');
    await wrapper.focus();
    await expect(wrapper).toHaveAccessibleDescription(/zoom in.*pan.*reset/u);
    await page.keyboard.press('=');
    const zoomed = await range(page, 'source');
    expect(zoomed[0]).toBeGreaterThan(x(20));
    expect(zoomed[1]).toBeLessThan(x(80));
    await expect.poll(() => range(page, 'late')).toEqual(zoomed);
    await page.keyboard.press('ArrowRight');
    expect((await range(page, 'source'))[0]).toBeGreaterThan(zoomed[0] as number);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('-');
    await page.keyboard.press('0');
    await expect.poll(() => range(page, 'source')).toEqual([x(0), x(100)]);
    expect(await range(page, 'peer')).toEqual([x(25), x(125)]);
    await expect(page.locator('#disjoint [role=status]')).toBeEmpty();
    await zoom(page, x(30), x(60));
    await page.locator('#peer').getByRole('button', { name: 'Reset view' }).click();
    await expect.poll(() => range(page, 'source')).toEqual([x(0), x(100)]);
  });
}

for (const [kind, axis] of [
  ...['line', 'scatter', 'area', 'band', 'errorbar', 'xy'].map((kind) => [kind, 'value']),
  ['line', 'time'],
  ['line', 'log']
]) {
  test(`propagates unsnapped ${kind} ${axis} cursor lines without remote tooltips`, async ({ page }) => {
    const expectedX = axis === 'time' ? Date.UTC(2026, 0, 1) + 43000 : axis === 'log' ? 44 : 43;
    await page.goto(
      `http://127.0.0.1:4323/?linked&kind=${kind}&axis=${axis}&tooltip=${kind === 'xy' ? 'false' : 'true'}`
    );
    await expect(page.locator('canvas')).toHaveCount(4);
    const point = await page.locator('#source .doc-plot').evaluate((plot, xValue) => {
      const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
      const [x, y] = chart?.convertToPixel({ seriesIndex: 0 }, [xValue, 4.3]) as number[];
      const box = plot.getBoundingClientRect();
      return { x: box.left + x, y: box.top + y };
    }, expectedX);
    await page.mouse.move(point.x, point.y);
    const sourceValue = await page.locator('#source .doc-plot').evaluate((plot) => {
      const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
      return (chart?.getOption().xAxis as { axisPointer: { value: number } }[])[0].axisPointer.value;
    });
    // Pointer coordinates have pixel precision; peers must preserve the source's exact value.
    expect(Math.abs(sourceValue - expectedX)).toBeLessThan(axis === 'time' ? 1000 : 2);
    await expect
      .poll(() =>
        page.locator('#peer .doc-plot').evaluate((plot) => {
          const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
          const axis = (chart?.getOption().xAxis as { axisPointer: { value: number; status: string } }[])[0]
            .axisPointer;
          return { value: axis.value, status: axis.status };
        })
      )
      .toEqual({ value: sourceValue, status: 'show' });
    // The peer's points are 35 and 45 around this cursor; the pointer must stay at 43.
    expect(
      await page
        .locator('#peer .doc-plot')
        .evaluate((plot) =>
          Array.from(plot.querySelectorAll('div')).some(
            (element) =>
              element.style.position === 'absolute' &&
              element.textContent?.trim() &&
              getComputedStyle(element).visibility !== 'hidden'
          )
        )
    ).toBe(false);
    await page.mouse.move(0, 0);
    await expect
      .poll(() =>
        page.locator('#peer .doc-plot').evaluate((plot) => {
          const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
          return (chart?.getOption().xAxis as { axisPointer: { status: string } }[])[0].axisPointer.status;
        })
      )
      .toBe('hide');
  });
}

test('pointer wheel zoom and drag pan synchronize peers by domain', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?linked');
  await expect(page.locator('canvas')).toHaveCount(4);
  const plot = page.locator('#source .doc-plot');
  await plot.hover();
  await page.mouse.wheel(0, -160);
  await expect.poll(() => range(page, 'source')).not.toEqual([0, 100]);
  const zoomed = await range(page, 'source');
  const box = await plot.boundingBox();
  if (!box) throw new Error('Source plot is missing.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => range(page, 'source')).not.toEqual(zoomed);
  const panned = await range(page, 'source');
  await expect
    .poll(() => range(page, 'peer'))
    .toEqual([Math.max(25, panned[0] as number), Math.min(125, panned[1] as number)]);
});

test('isolates invalid peers and cleans replacement and navigation state', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?linked');
  await expect(page.locator('canvas')).toHaveCount(4);
  await zoom(page, 30, 60);
  await page.getByRole('button', { name: 'Add incompatible peer' }).click();
  await expect(page.locator('#invalid [role=alert]')).toContainText('Artifact 1');
  await expect(page.locator('#invalid [role=alert]')).toContainText('unit');
  await expect(page.locator('#invalid canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle source' }).click();
  await expect(page.locator('#source')).toHaveCount(0);
  await page.getByRole('button', { name: 'Toggle source' }).click();
  await expect.poll(() => range(page, 'source')).toEqual([30, 60]);
  await page.getByRole('button', { name: 'Navigate to fresh page' }).click();
  await expect.poll(() => range(page, 'source')).toEqual([0, 100]);
  expect(await range(page, 'peer')).toEqual([25, 125]);
  expect((await new AxeBuilder({ page }).include('#source').analyze()).violations).toEqual([]);
});

test('unlinked charts support keyboard navigation and localized instructions', async ({ page }) => {
  await page.goto('http://127.0.0.1:4323/?fixture=years&locale=ja');
  await expect(page.locator('canvas')).toHaveCount(1);
  const wrapper = page.locator('.doc-chart-output__viewport');
  await expect(wrapper).toHaveAccessibleDescription(/矢印キー/u);
  await wrapper.focus();
  await page.keyboard.press('+');
  const option = () =>
    page.locator('.doc-plot').evaluate((plot) => {
      const chart = window.galleryECharts.getInstanceByDom(plot as HTMLElement);
      return (chart?.getOption().dataZoom as { start: number; end: number }[])[0];
    });
  expect((await option()).start).toBeGreaterThan(0);
  await page.keyboard.press('0');
  expect(await option()).toMatchObject({ start: 0, end: 100 });
});

test('documentation panels link across real cells without executing them again', async ({ page }) => {
  await page.addInitScript(`
    globalThis.__linkedChartExecutions = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...rest) {
      if (message?.type === 'execute') globalThis.__linkedChartExecutions += 1;
      return Reflect.apply(original, this, [message, ...rest]);
    };
  `);
  await page.goto('/features/rich-output/');
  const source = page.getByTestId('cell-features__rich-output__linked-observations');
  const peer = page.getByTestId('cell-features__rich-output__linked-residuals');
  for (const cell of [source, peer]) {
    await cell.scrollIntoViewIfNeeded();
    await expect.poll(() => cell.locator('xpath=ancestor::astro-island').getAttribute('ssr')).toBeNull();
    await cell.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(cell.locator('.doc-plot canvas')).toBeVisible();
  }
  const executions = () => page.evaluate(() => Reflect.get(globalThis, '__linkedChartExecutions') as number);
  const before = await executions();
  const image = () => peer.locator('.doc-plot canvas').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.mouse.move(0, 0);
  const initial = await image();
  await source.locator('.doc-chart-output__viewport').focus();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await expect.poll(image).not.toBe(initial);
  expect(await executions()).toBe(before);
  await page.keyboard.press('0');
  expect(await executions()).toBe(before);
});
