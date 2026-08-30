import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const wcag22AATags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

test.describe('runtime accessibility', () => {
  test('desktop table-of-contents control remains accessible when expanded and collapsed', async ({
    browserName,
    page
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/features/math/');

    const toggle = page.getByRole('button', { name: 'Collapse table of contents' });
    await toggle.focus();
    await toggle.press('Space');

    const expandedToggle = page.getByRole('button', { name: 'Expand table of contents' });
    await expect(expandedToggle).toHaveAttribute('aria-controls', 'starlight__right-sidebar');
    await expect(expandedToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(expandedToggle).toBeFocused();
    await expect(page.locator('#starlight__right-sidebar')).toHaveAttribute('inert', '');
    await expectNoWcag22AAViolations(page, browserName);
  });

  test('interactive cells expose localized semantics and support keyboard-only execution', async ({
    browserName,
    page
  }) => {
    test.setTimeout(180_000);

    await page.goto('/features/interactive-cells/');
    const englishCell = page.getByTestId('cell-features__interactive-cells__run-mode-button');
    await hydrateCell(englishCell);

    const englishInput = englishCell.getByRole('spinbutton', { name: 'Input value' });
    await expect(englishInput).toHaveAccessibleDescription('Choose an integer from 1 through 10.');
    await englishInput.focus();
    await englishInput.press('ArrowUp');
    await expect(englishInput).toHaveValue('4');

    const sourceToggle = englishCell.getByRole('button', { name: 'Hide code' });
    await sourceToggle.focus();
    await sourceToggle.press('Enter');
    const collapsedSourceToggle = englishCell.getByRole('button', { name: 'Show code' });
    await expect(collapsedSourceToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(collapsedSourceToggle).toBeFocused();

    const runButton = englishCell.getByRole('button', { name: 'Run' });
    await runButton.focus();
    await runButton.press('Enter');
    await expect(englishCell.getByTestId('run-output')).toContainText('button value = 4');
    await expect(runButton).toBeFocused();
    await expectNoWcag22AAViolations(page, browserName);

    await page.goto('/ja/features/interactive-cells/');
    const japaneseCell = page.getByTestId('cell-ja__features__interactive-cells__run-mode-button');
    await hydrateCell(japaneseCell);
    await expect(japaneseCell.getByRole('button', { name: '実行' })).toBeVisible();
    await expect(japaneseCell.getByRole('region', { name: 'Explicit button execution の出力' })).toBeVisible({
      timeout: 10_000
    });
    await expectNoWcag22AAViolations(page, browserName);
  });

  test('rich outputs provide accessible chart and table equivalents in both locales', async ({ browserName, page }) => {
    test.setTimeout(240_000);

    for (const example of [
      {
        path: '/features/rich-output/',
        cellId: 'cell-features__rich-output__rust-rich-outputs',
        runLabel: 'Run',
        tableLabel: 'Data table'
      },
      {
        path: '/ja/features/rich-output/',
        cellId: 'cell-ja__features__rich-output__rust-rich-outputs',
        runLabel: '実行',
        tableLabel: 'データ表'
      }
    ]) {
      await page.goto(example.path);
      const cell = page.getByTestId(example.cellId);
      await hydrateCell(cell);
      await cell.getByRole('button', { name: example.runLabel }).press('Enter');
      await expect(cell.getByRole('table', { name: example.tableLabel }).first()).toBeVisible();
      await expect(cell.getByRole('figure').first()).toHaveAccessibleDescription(/Data items|データ数/u);
      await expect(cell.getByTestId('doc-plot').first()).toHaveAttribute('aria-hidden', 'true');
      await expectNoWcag22AAViolations(page, browserName);
    }
  });

  test('Mermaid diagrams expose a localized image name and description', async ({ browserName, page }) => {
    for (const example of [
      { path: '/features/diagrams/', name: /Mermaid (?:flowchart|diagram)/u, description: /Diagram source:/u },
      { path: '/ja/features/diagrams/', name: /Mermaid (?:フローチャート|図)/u, description: /図のソース:/u }
    ]) {
      await page.goto(example.path);
      const diagram = page.getByRole('img', { name: example.name }).first();
      await diagram.scrollIntoViewIfNeeded();
      await expect(diagram).toHaveAccessibleDescription(example.description);
      await expect(diagram.locator('svg')).toHaveAttribute('aria-hidden', 'true');
      await expectNoWcag22AAViolations(page, browserName);
    }
  });
});

async function expectNoWcag22AAViolations(page: Page, browserName: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(wcag22AATags);
  if (browserName === 'webkit') builder.setLegacyMode();
  const results = await builder.analyze();
  const summary = results.violations.map(({ help, id, nodes }) => ({ help, id, nodes: nodes.length }));
  expect(results.violations, JSON.stringify(summary, null, 2)).toEqual([]);
}

async function hydrateCell(cell: Locator): Promise<void> {
  await cell.scrollIntoViewIfNeeded();
  const island = cell.locator('xpath=ancestor::astro-island');
  await expect.poll(() => island.getAttribute('ssr')).toBeNull();
}
