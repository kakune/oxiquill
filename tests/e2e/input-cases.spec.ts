import { expect, test } from '@playwright/test';

type BrowserState = typeof globalThis & {
  __caseRequests: Array<{ cellId: string; inputs: Record<string, unknown> }>;
  __caseShare?: string;
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const state = globalThis as BrowserState;
    state.__caseRequests = [];
    const postMessage = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      raw: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions
    ) {
      const message = raw as { cellId?: string; inputs?: Record<string, unknown> };
      if (message?.cellId && message.inputs)
        state.__caseRequests.push({ cellId: message.cellId, inputs: message.inputs });
      const send = postMessage.bind(this);
      if (Array.isArray(transferOrOptions)) send(raw, transferOrOptions);
      else send(raw, transferOrOptions);
    };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          state.__caseShare = value;
        }
      }
    });
  });
});

for (const locale of ['en', 'ja']) {
  const japanese = locale === 'ja';
  const prefix = japanese ? 'ja__' : '';
  const path = `${japanese ? '/ja' : ''}/features/interactive-cells/`;
  const cellId = `${prefix}features__interactive-cells__named-cases`;
  const values = { samples: 800, noise: 0.05, seed: 7, model: 'robust', enabled: false };

  test(`applies cases with the keyboard, shares private authored values, and resets (${locale})`, async ({ page }) => {
    await page.goto(`${path}?keep=1#named-cases`);
    const cell = page.getByTestId(`cell-${cellId}`);
    await cell.scrollIntoViewIfNeeded();
    const selector = cell.getByRole('combobox', { name: japanese ? 'ケース' : 'Case', exact: true });
    await expect(selector).toHaveValue('');
    await expect(selector.locator('option').first()).toHaveText(japanese ? 'カスタム値' : 'Custom values');
    await expect(cell.getByTestId('run-output')).toContainText('samples = 100');
    const requests = () =>
      page.evaluate(
        (id) => (globalThis as BrowserState).__caseRequests.filter((request) => request.cellId === id),
        cellId
      );
    expect(await requests()).toHaveLength(1);
    await selector.focus();
    await selector.press('ArrowDown');
    await selector.press('Enter');
    await expect(selector).toHaveValue('low-noise');
    await expect(selector).toBeFocused();
    await expect(selector).toHaveAccessibleDescription(
      japanese ? 'サンプル数を増やし、ノイズを減らします。' : 'Many samples with little noise.'
    );
    await expect(cell.getByRole('spinbutton', { name: 'Samples', exact: true })).toHaveValue('800');
    await expect(cell.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('7');
    await expect(cell.getByRole('slider', { name: 'Noise', exact: true })).toHaveValue('0.05');
    await expect(cell.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('robust');
    await expect(cell.getByRole('checkbox', { name: 'Enabled', exact: true })).not.toBeChecked();
    await expect(cell.getByTestId('run-output')).toContainText(
      'samples = 800, noise = 0.05, seed = 7, model = robust, enabled = false'
    );
    await page.waitForTimeout(200);
    expect((await requests()).map((request) => request.inputs)).toEqual([
      { samples: 100, noise: 0.1, seed: 1, model: 'simple', enabled: true },
      values
    ]);

    await cell
      .getByRole('button', { name: japanese ? '入力のリンクをコピー' : 'Copy input link', exact: true })
      .click();
    const shared = await page.evaluate(() => (globalThis as BrowserState).__caseShare);
    expect(shared).toBeTruthy();
    if (!shared) throw new Error('Expected an input sharing link.');
    const url = new URL(shared);
    const payload = JSON.parse(url.searchParams.get('oxiquill-inputs') ?? '{}');
    expect(payload.v).toBe(2);
    expect(payload.cells[cellId]).toEqual({ values: { samples: 800 }, case: 'low-noise' });
    expect(url.searchParams.get('keep')).toBe('1');
    expect(url.hash).toBe('#named-cases');

    await page.goto(url.href);
    await cell.scrollIntoViewIfNeeded();
    await expect(selector).toHaveValue('low-noise');
    await expect(cell.getByTestId('run-output')).toContainText('seed = 7, model = robust, enabled = false');
    expect((await requests()).map((request) => request.inputs)).toEqual([values]);
    const samples = cell.getByRole('spinbutton', { name: 'Samples', exact: true });
    await samples.fill('790');
    await expect(selector).toHaveValue('');
    await samples.fill('800');
    await expect(selector).toHaveValue('low-noise');
    await cell.getByRole('button', { name: japanese ? '入力を初期値に戻す' : 'Reset inputs' }).press('Enter');
    await expect(selector).toHaveValue('');
    await expect(samples).toHaveValue('100');
    await expect(cell.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('1');
  });

  test(`button cells wait for Run and unknown case ids fall back to shared values (${locale})`, async ({ page }) => {
    const payload = encodeURIComponent(
      JSON.stringify({ v: 2, cells: { [cellId]: { values: { samples: 20, seed: 7 }, case: 'removed' } } })
    );
    await page.goto(`${path}?oxiquill-inputs=${payload}`);
    const reactive = page.getByTestId(`cell-${cellId}`);
    await reactive.scrollIntoViewIfNeeded();
    await expect(reactive.getByRole('combobox', { name: japanese ? 'ケース' : 'Case', exact: true })).toHaveValue('');
    await expect(reactive.getByRole('spinbutton', { name: 'Samples', exact: true })).toHaveValue('20');
    await expect(reactive.getByRole('spinbutton', { name: 'Seed', exact: true })).toHaveValue('1');
    const buttonId = `${prefix}features__interactive-cells__run-mode-button`;
    const buttonCell = page.getByTestId(`cell-${buttonId}`);
    await buttonCell.scrollIntoViewIfNeeded();
    const selector = buttonCell.getByRole('combobox', { name: japanese ? 'ケース' : 'Case', exact: true });
    await selector.focus();
    await selector.press('ArrowDown');
    await selector.press('Enter');
    await expect(selector).toHaveValue('small');
    await expect(buttonCell.getByRole('spinbutton', { name: 'Input value', exact: true })).toHaveValue('1');
    expect(
      await page.evaluate(
        (id) => (globalThis as BrowserState).__caseRequests.filter((request) => request.cellId === id),
        buttonId
      )
    ).toHaveLength(0);
    await buttonCell.getByRole('button', { name: japanese ? '実行' : 'Run', exact: true }).press('Enter');
    await expect(buttonCell.getByTestId('run-output')).toContainText('button value = 1');
    // Existing cells without cases keep their original controls.
    const plain = page.getByTestId(`cell-${prefix}features__interactive-cells__rust-controls`);
    await expect(plain.getByRole('combobox', { name: japanese ? 'ケース' : 'Case', exact: true })).toHaveCount(0);
  });
}
