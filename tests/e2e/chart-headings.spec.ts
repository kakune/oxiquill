import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';

for (const width of [360, 720]) {
  for (const theme of ['light', 'dark']) {
    test(`untitled chart heading ${width}px ${theme}`, async ({ page, browserName }, testInfo) => {
      await page.setViewportSize({ width: width + 40, height: 800 });
      for (const locale of ['en', 'ja']) {
        await page.goto(
          `http://127.0.0.1:4323/?fixture=single&width=${width}&theme=${theme}&locale=${locale}&caption=none&specTitle=%20`
        );
        const figure = page.getByRole('figure', { name: labelsForLanguage(locale).chartTitle('line'), exact: true });
        await expect(figure).toBeVisible();
        await expect(figure.locator('.doc-plot canvas')).toBeVisible();
        await expect(figure.locator('strong')).toHaveClass('doc-visually-hidden');
        const spacing = await figure.evaluate((element) => {
          const actions = element.querySelector('.doc-chart-output__actions');
          return (actions?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top;
        });
        expect(Math.abs(spacing)).toBeLessThan(1);
        expect((await new AxeBuilder({ page }).include('.doc-chart-output').analyze()).violations).toEqual([]);
        if (browserName === 'chromium')
          await figure.screenshot({ path: testInfo.outputPath(`gallery-heading-${width}-${theme}-${locale}.png`) });
      }
      await page.goto(
        `http://127.0.0.1:4323/?fixture=single&width=${width}&theme=${theme}&artifactTitle=%20&specTitle=Authored`
      );
      const figure = page.getByRole('figure', { name: 'Authored', exact: true });
      await expect(figure.locator('strong')).not.toHaveClass('doc-visually-hidden');
      await expect(figure.locator('figcaption')).toHaveText('AuthoredRevision 0');
    });
  }
}
