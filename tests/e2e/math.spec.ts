import { expect, test } from '@playwright/test';

test('KaTeX scripts use upstream sizing in inline and display formulas', async ({ page }) => {
  await page.goto('/features/math/');
  for (const selector of ['p > .katex', '.katex-display > .katex']) {
    const ratios = await page.locator(`${selector} .katex-html .sizing.reset-size6.size3`).evaluateAll((scripts) =>
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
