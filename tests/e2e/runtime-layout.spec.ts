import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

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
