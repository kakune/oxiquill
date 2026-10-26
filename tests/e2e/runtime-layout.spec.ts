import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const cells = [
  { path: '/guides/python-runtime/', id: 'guides__python-runtime__setup-mean' },
  { path: '/features/interactive-cells/', id: 'features__interactive-cells__python-controls' },
  { path: '/ja/features/interactive-cells/', id: 'ja__features__interactive-cells__python-controls' }
];

const viewports = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

function verticalBoxes(locator: Locator) {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        marginTop: getComputedStyle(element).marginTop
      };
    })
  );
}

for (const cell of cells) {
  for (const viewport of viewports) {
    test(`cell controls keep their own spacing inside Markdown (${cell.path}, ${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(cell.path);
      const section = page.getByTestId(`cell-${cell.id}`);
      await section.scrollIntoViewIfNeeded();
      await expect(section.locator('xpath=ancestor::astro-island[1]')).not.toHaveAttribute('ssr', '', {
        timeout: 30_000
      });

      await expect(page.locator('.doc-cell:not(.not-content)')).toHaveCount(0);
      const descendants = await verticalBoxes(
        page.locator('.doc-cell :is(button, p, pre, fieldset, figure, div):not(.doc-visually-hidden)')
      );
      expect(descendants.filter(({ marginTop }) => marginTop !== '0px')).toEqual([]);

      // Buttons in one row share a top edge; wrapped rows are separated only by the 8px gap.
      const actions = await verticalBoxes(section.locator('.doc-cell__actions > button'));
      expect(actions.length).toBeGreaterThanOrEqual(3);
      const misplaced = actions
        .slice(1)
        .map((box, index) => ({ previous: actions[index], box }))
        .filter(({ previous, box }) => box.top !== previous.top && box.top - previous.bottom !== 8);
      expect(misplaced).toEqual([]);
      if (viewport.name === 'mobile') expect(new Set(actions.map(({ top }) => top)).size).toBe(actions.length);
    });
  }
}

test('diagram figures keep their own spacing inside Markdown', async ({ page }) => {
  await page.goto('/features/diagrams/');
  const figure = page.getByTestId('mermaid-diagram').first();
  await figure.scrollIntoViewIfNeeded();
  await expect(figure).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.mermaid-diagram:not(.not-content)')).toHaveCount(0);
  const descendants = await verticalBoxes(figure.locator(':is(div, p, figcaption):not(.doc-visually-hidden)'));
  expect(descendants.filter(({ marginTop }) => marginTop !== '0px')).toEqual([]);
});

const sourceMarker = 'OXIQUILL_SOURCE_END';

async function layoutFixture(page: Page, attributes: Record<string, string>, theme = 'light') {
  await page.addInitScript(
    ({ attributes, theme }) => {
      localStorage.setItem('starlight-theme', theme);
      const apply = () => {
        if (!document.documentElement) return;
        for (const [name, value] of Object.entries(attributes)) document.documentElement.setAttribute(name, value);
      };
      document.addEventListener('DOMContentLoaded', apply);
      apply();
    },
    { attributes, theme }
  );
}

async function sourceCell(page: Page) {
  await page.goto('/tests/source-overflow/');
  const cell = page.getByTestId('cell-tests__source-overflow__source-overflow');
  await cell.scrollIntoViewIfNeeded();
  await expect(cell.locator('xpath=ancestor::astro-island[1]')).not.toHaveAttribute('ssr', '', {
    timeout: 30_000
  });
  return cell;
}

function sourceGeometry(pre: Locator) {
  return pre.evaluate((element, marker) => {
    const cell = element.closest('.doc-cell');
    if (!cell) throw new Error('Source must belong to a cell');
    const frame = element.getBoundingClientRect();
    const cellBox = cell.getBoundingClientRect();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent?.includes(marker)) node = walker.nextNode();
    if (!node) throw new Error('Source marker is missing');
    const start = (node.textContent ?? '').indexOf(marker);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + marker.length);
    const markerBox = range.getBoundingClientRect();
    return {
      frame: { x: frame.x - cellBox.x, y: frame.y - cellBox.y, width: frame.width, height: frame.height },
      marker: { x: markerBox.x - frame.x, y: markerBox.y - frame.y, right: markerBox.right - frame.x },
      scrollLeft: element.scrollLeft,
      scrollTop: element.scrollTop,
      clipped: !element.contains(document.elementFromPoint(frame.right + 4, frame.top + 40))
    };
  }, sourceMarker);
}

async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ).toBeLessThanOrEqual(1);
}

async function centerMouse(page: Page, pre: Locator) {
  await pre.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  const box = await pre.boundingBox();
  if (!box) throw new Error('Source frame is missing');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

for (const theme of ['light', 'dark']) {
  for (const viewport of viewports) {
    test(`source scrolls inside its themed frame (${theme}, ${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await layoutFixture(page, {}, theme);
      const cell = await sourceCell(page);
      const pre = cell.getByTestId('cell-source').locator('pre');
      await expect(pre).toHaveCSS('max-height', 'none');
      await centerMouse(page, pre);
      const before = await sourceGeometry(pre);
      await pre.evaluate((element) => element.scrollTo({ left: 180, behavior: 'instant' }));
      const after = await sourceGeometry(pre);
      expect(after.frame).toEqual(before.frame);
      expect(after.scrollLeft).toBeGreaterThan(0);
      expect(after.marker.x).toBeCloseTo(before.marker.x - after.scrollLeft, 0);
      expect(after.clipped).toBe(true);
      const wrapper = cell.getByTestId('cell-source');
      expect(
        await wrapper.evaluate((element) => {
          element.scrollLeft = 180;
          return { overflow: getComputedStyle(element).overflow, scrollLeft: element.scrollLeft };
        })
      ).toEqual({ overflow: 'visible', scrollLeft: 0 });
      const colors = await pre.evaluate((element, theme) => {
        const style = document.createElement('span').style;
        style.color =
          theme === 'dark' ? element.style.getPropertyValue('--shiki-dark-bg') : element.style.backgroundColor;
        return [getComputedStyle(element).backgroundColor, style.color];
      }, theme);
      expect(colors[0]).toBe(colors[1]);
      await expectNoPageOverflow(page);

      await cell.getByRole('button', { name: 'Hide code' }).click();
      await expect(pre).toHaveCount(0);
      await cell.getByRole('button', { name: 'Show code' }).click();
      await expect(pre).toBeVisible();
      const restored = await sourceGeometry(pre);
      for (const property of ['x', 'y', 'width', 'height'] as const) {
        expect(restored.frame[property]).toBeCloseTo(before.frame[property], 2);
      }
      expect(restored.scrollLeft).toBe(0);

      await cell.getByRole('button', { name: 'Run', exact: true }).click();
      const output = cell.getByTestId('run-output');
      await expect(output).toContainText(sourceMarker);
      const outputBefore = await output.boundingBox();
      await output.evaluate((element) => element.scrollTo({ left: 180, behavior: 'instant' }));
      expect(await output.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      expect(await output.boundingBox()).toEqual(outputBefore);
      await expectNoPageOverflow(page);
    });

    test(`bounded source routes wheel and keyboard scrolling (${theme}, ${viewport.name})`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await layoutFixture(page, { 'data-test-source-height': 'bounded' }, theme);
      const cell = await sourceCell(page);
      const pre = cell.getByTestId('cell-source').locator('pre');
      await centerMouse(page, pre);
      const before = await sourceGeometry(pre);
      expect(before.frame.height).toBeLessThanOrEqual(192);
      await pre.evaluate((element) => element.scrollTo({ top: 100, behavior: 'instant' }));
      const after = await sourceGeometry(pre);
      expect(after.frame).toEqual(before.frame);
      expect(after.scrollTop).toBeGreaterThan(0);
      expect(after.marker.y).toBeCloseTo(before.marker.y - after.scrollTop, 0);

      await pre.evaluate((element) => element.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
      await centerMouse(page, pre);
      await page.mouse.wheel(160, 0);
      await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await page.mouse.wheel(0, 160);
      await expect.poll(() => pre.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

      await cell.getByRole('button', { name: 'Run', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(pre).toBeFocused();
      expect(await pre.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
      await expect(pre).toHaveCSS('outline-style', 'solid');
      await expect(pre).toHaveCSS('outline-width', '3px');
      await pre.evaluate((element) => element.scrollTo({ left: 0, top: 0, behavior: 'instant' }));
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => pre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      await page.keyboard.press('ArrowDown');
      await expect.poll(() => pre.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await expectNoPageOverflow(page);
    });
  }
}

test('bounded dark source prints complete wrapped source in light colors', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await layoutFixture(page, { 'data-test-source-height': 'bounded' }, 'dark');
  const cell = await sourceCell(page);
  const pre = cell.getByTestId('cell-source').locator('pre');
  await expect(pre).toHaveCSS('max-height', '192px');
  await page.emulateMedia({ media: 'print' });
  try {
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLLinkElement>('link[media="print"]')].every((link) => link.sheet)
    );
    await expect(pre).toHaveCSS('max-height', 'none');
    await expect(pre).toHaveCSS('white-space', 'pre-wrap');
    const overflow = await pre.evaluate((element) => ({
      vertical: element.scrollHeight - element.clientHeight,
      horizontal: element.scrollWidth - element.clientWidth
    }));
    expect(overflow.vertical).toBeLessThanOrEqual(1);
    expect(overflow.horizontal).toBeLessThanOrEqual(1);
    const { marker, frame } = await sourceGeometry(pre);
    expect(marker.x).toBeGreaterThanOrEqual(0);
    expect(marker.right).toBeLessThanOrEqual(frame.width);
    expect(marker.y).toBeGreaterThanOrEqual(0);
    expect(marker.y).toBeLessThan(frame.height);
    const colors = await pre.locator('span[style*="color:"]').evaluateAll((elements) =>
      elements.map((element) => ({
        actual: getComputedStyle(element).color,
        light: (element as HTMLElement).style.color
      }))
    );
    expect(colors.length).toBeGreaterThan(0);
    for (const color of colors) expect(color.actual).toBe(color.light);
    // Starlight's print measure must still take precedence on the main pane.
    expect(
      await page
        .locator('.main-pane')
        .evaluate((element) => getComputedStyle(element).getPropertyValue('--sl-content-width').trim())
    ).toBe('100%');
  } finally {
    await page.emulateMedia({ media: null });
  }
});

function contentMeasure(page: Page) {
  return page
    .locator('main .content-panel')
    .last()
    .evaluate((panel) => {
      const container = panel.querySelector(':scope > .sl-container');
      if (!container) throw new Error('Content container is missing');
      const style = getComputedStyle(panel);
      return {
        width: container.getBoundingClientRect().width,
        available: panel.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      };
    });
}

async function navigationState(page: Page, sidebar: boolean, toc: boolean) {
  const root = page.locator('html');
  await expect.poll(() => root.getAttribute('data-sidebar-collapsed')).toBe(sidebar ? '' : null);
  await expect.poll(() => root.getAttribute('data-table-of-contents-collapsed')).toBe(toc ? '' : null);
}

for (const fixture of ['default', 'fixed', 'fluid']) {
  test(`navigation preserves the ${fixture} content measure across toggles and restoration`, async ({ page }) => {
    await page.setViewportSize({ width: 2400, height: 1200 });
    await layoutFixture(page, fixture === 'default' ? {} : { 'data-test-content-width': fixture });
    await page.goto('/features/math/');
    const sidebar = page.locator('starlight-sidebar-toggle button');
    const toc = page.locator('starlight-table-of-contents-toggle button');
    const base = fixture === 'fixed' ? 1280 : 720;
    const sidebarWidth = fixture === 'fixed' ? 320 : 300;
    async function expectMeasure(released: number) {
      await expect
        .poll(async () => {
          const measure = await contentMeasure(page);
          const expected =
            fixture === 'fluid' ? measure.available : Math.min(base + released * sidebarWidth, measure.available);
          return Math.abs(measure.width - expected);
        })
        .toBeLessThanOrEqual(1);
      return (await contentMeasure(page)).width;
    }

    await navigationState(page, false, false);
    const expanded = await expectMeasure(0);
    await sidebar.click();
    await navigationState(page, true, false);
    expect(await expectMeasure(1)).toBeGreaterThanOrEqual(expanded);
    await sidebar.click();
    await toc.click();
    await navigationState(page, false, true);
    expect(await expectMeasure(1)).toBeGreaterThanOrEqual(expanded);
    await sidebar.click();
    await navigationState(page, true, true);
    expect(await expectMeasure(2)).toBeGreaterThanOrEqual(expanded);
    await page.reload();
    await navigationState(page, true, true);
    await expectMeasure(2);
    await page.goto('/features/diagrams/');
    await navigationState(page, true, true);
    await expectMeasure(2);

    for (const [width, left, right, released] of [
      [1000, true, false, 1],
      [600, false, false, 0],
      [2400, true, true, 2]
    ] as const) {
      await page.setViewportSize({ width, height: 1200 });
      await navigationState(page, left, right);
      await expectMeasure(released);
    }
    await page.goto('/tests/no-table-of-contents/');
    await navigationState(page, true, false);
    await expect(toc).toHaveCount(0);
    await expectMeasure(1);
  });
}
