import { expect, test } from '@playwright/test';

test('failed Python figures never leak into later executions', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Real Pyodide lifecycle coverage runs in Chromium.');
  test.setTimeout(240_000);
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await cell.scrollIntoViewIfNeeded();
  await cell.getByRole('button', { name: 'Edit Python', exact: true }).click();
  const source = cell.getByLabel('Python draft');
  const run = cell.getByRole('button', { name: 'Run', exact: true });
  for (const displayed of [false, true]) {
    await source.fill(
      `import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.set_title("Failed figure")\n${displayed ? 'display(fig)\n' : ''}raise ValueError("intentional failure")`
    );
    await run.click();
    await expect(cell.locator('.doc-cell__error')).toContainText('intentional failure', { timeout: 180_000 });
    await source.fill('print("Clean execution")');
    await run.click();
    await expect(cell.getByTestId('run-output')).toContainText('Clean execution');
    await expect(cell.getByTestId('image-output')).toHaveCount(0);
  }
  await source.fill('import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.set_title("Current figure")');
  await run.click();
  await expect(cell.getByTestId('image-output')).toHaveCount(1);
  await expect(cell.getByTestId('image-output')).toHaveAttribute('alt', 'Current figure');
  await source.fill('from itertools import count\ndisplay_table(([n] for n in count()))');
  await run.click();
  await expect(cell.getByTestId('table-output')).toContainText('total unknown; truncated');
  await expect(cell.getByTestId('table-output')).toContainText('10000 retrieved rows');
});
