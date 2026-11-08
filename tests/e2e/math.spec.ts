import { expect, test } from '@playwright/test';

test('KaTeX scripts use upstream sizing in inline and display formulas', async ({ page }) => {
  await page.goto('/features/math/');
  for (const selector of ['p > .katex', '.katex-display > .katex']) {
    const ratios = await page
      .locator(`${selector} .katex-html .katex-sizing.reset-size6.size3`)
      .evaluateAll((scripts) =>
        scripts.map((script) => ({
          text: script.textContent,
          ratio:
            Number.parseFloat(getComputedStyle(script).fontSize) /
            Number.parseFloat(getComputedStyle(script.closest('.katex') ?? script).fontSize)
        }))
      );
    expect(ratios.some(({ text }) => text?.includes('n'))).toBe(true);
    expect(ratios.some(({ text }) => text?.includes('2'))).toBe(true);
    for (const { ratio } of ratios) expect(Math.abs(ratio - 0.7)).toBeLessThan(0.02);
  }
});

test('long display equations scroll inside themselves', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/features/math/');
  const display = page.locator('.sl-heading-wrapper:has(#long-equations) ~ .katex-display').first();
  await display.scrollIntoViewIfNeeded();

  const overflow = await display.evaluate((element) => ({
    inside: element.scrollWidth - element.clientWidth,
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }));
  expect(overflow.inside).toBeGreaterThan(0);
  expect(overflow.page).toBeLessThanOrEqual(1);

  await expect(display).toHaveAttribute('tabindex', '0');
  await display.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => display.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
});
