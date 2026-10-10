import { expect, test } from '@playwright/test';

test('matplotlib styles, text alternatives, overrides, and large-figure fallback work in Pyodide', async ({
  page,
  browserName
}) => {
  test.skip(browserName !== 'chromium', 'The real Pyodide image contract is exercised in Chromium.');
  test.setTimeout(240_000);
  await page.addInitScript(
    (source: string) => {
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        if (
          message &&
          typeof message === 'object' &&
          'cellId' in message &&
          message.cellId === 'features__rich-output__python-rich-outputs'
        )
          message = { ...message, source };
        return Reflect.apply(post, this, [message, options]);
      };
    },
    `
import matplotlib
import matplotlib.pyplot as plt
import numpy as np

assert matplotlib.rcParams["axes.grid"]
assert matplotlib.rcParams["svg.fonttype"] == "none"
assert matplotlib.rcParams["axes.prop_cycle"].by_key()["color"][0] == "#3987e5"
first, axes = plt.subplots()
first.suptitle("Measurement report")
axes.set_title("日本語の題")
axes.set_xlabel("Time")
axes.set_ylabel("Value")
axes.plot([0, 1, 2], [1, 2, 1])
display(first)

matplotlib.rcParams["axes.grid"] = False
matplotlib.rcParams["lines.color"] = "#123456"
second, axes = plt.subplots()
axes.plot([0, 1], [0, 1], color="#123456")
axes.set_title("Author override")
assert not any(line.get_visible() for line in axes.get_xgridlines())
display(second)

matplotlib.rcdefaults()
assert not matplotlib.rcParams["axes.grid"]
third, axes = plt.subplots()
axes.set_title("Large scatter")
samples = np.arange(100000)
_ = axes.scatter(samples, np.sin(samples), s=2)
`
  );
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await cell.scrollIntoViewIfNeeded();
  await expect.poll(() => cell.locator('xpath=ancestor::astro-island').getAttribute('ssr')).toBeNull();
  await expect(cell.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();
  await cell.getByRole('button', { name: 'Run', exact: true }).click();
  const images = cell.getByTestId('image-output');
  await expect(cell.locator('[data-testid="image-output"], .error-state').first()).toBeVisible({ timeout: 180_000 });
  await expect(images).toHaveCount(3, { timeout: 180_000 });
  await expect(images.nth(0)).toHaveAttribute('alt', 'Measurement report; 日本語の題; Time; Value');
  await expect(images.nth(0)).toHaveAttribute('src', /^data:image\/svg\+xml/);
  await expect(images.nth(1)).toHaveAttribute('alt', 'Author override');
  await expect(images.nth(2)).toHaveAttribute('alt', 'Large scatter');
  await expect(images.nth(2)).toHaveAttribute('src', /^data:image\/png/);
  await expect(cell).toContainText('rendered PNG at 150 DPI');
  expect(
    await images.nth(0).evaluate(async (element) => {
      const svg = await fetch((element as HTMLImageElement).src).then((response) => response.text());
      return svg.includes('<text') && svg.includes('日本語の題') && svg.includes('#3987e5');
    })
  ).toBe(true);
  expect(
    await images
      .nth(1)
      .evaluate(async (element) =>
        (await fetch((element as HTMLImageElement).src).then((response) => response.text())).includes('#123456')
      )
  ).toBe(true);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect(await images.nth(0).evaluate((element) => getComputedStyle(element).filter)).toBe('none');
});
