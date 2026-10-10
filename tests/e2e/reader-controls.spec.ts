import { expect, test } from '@playwright/test';

for (const locale of ['en', 'ja']) {
  test(`restores shared inputs before execution and edits Python locally (${locale})`, async ({ page }) => {
    test.setTimeout(120_000);
    const prefix = locale === 'ja' ? 'ja__' : '';
    const cellId = `${prefix}features__interactive-cells__python-controls`;
    const path = `${locale === 'ja' ? '/ja' : ''}/features/interactive-cells/`;
    const payload = encodeURIComponent(
      JSON.stringify({ v: 1, cells: { [cellId]: { scale: 4, label: 'not shared' } } })
    );
    await page.goto(`${path}?keep=1&oxiquill-inputs=${payload}#python-inputs`);
    const cell = page.getByTestId(`cell-${cellId}`);
    await cell.scrollIntoViewIfNeeded();
    const scale = cell.getByRole('spinbutton', { name: 'scale' });
    await expect(scale).toHaveValue('4');
    await expect(cell.getByTestId('run-output')).toContainText('10', { timeout: 90_000 });
    await scale.fill('-');
    await cell.getByRole('button', { name: locale === 'ja' ? '入力を初期値に戻す' : 'Reset inputs' }).press('Enter');
    await expect(scale).toHaveValue('3');
    await cell.getByRole('button', { name: locale === 'ja' ? 'Pythonを編集' : 'Edit Python' }).click();
    const editor = cell.getByRole('textbox', { name: locale === 'ja' ? 'Pythonの編集用コード' : 'Python draft' });
    await editor.fill('print("draft result", scale)');
    await cell.getByRole('button', { name: locale === 'ja' ? '実行' : 'Run', exact: true }).click();
    await expect(cell.getByTestId('run-output')).toContainText('draft result 3');
    await editor.fill('print(');
    await cell.getByRole('button', { name: locale === 'ja' ? '実行' : 'Run', exact: true }).click();
    await expect(cell.getByRole('alert')).toContainText('SyntaxError');
    await editor.fill('import scipy');
    await cell.getByRole('button', { name: locale === 'ja' ? '実行' : 'Run', exact: true }).click();
    await expect(cell.getByRole('alert')).toContainText('scipy');
    await editor.fill('print("recovered")');
    await cell.getByRole('button', { name: locale === 'ja' ? '実行' : 'Run', exact: true }).click();
    await expect(cell.getByTestId('run-output')).toContainText('recovered');
    await cell.getByRole('button', { name: locale === 'ja' ? '編集を終了' : 'Finish editing' }).click();
    await expect(editor).toHaveCount(0);
    await expect(cell.getByTestId('run-output')).toContainText('7.5');
  });
}
