import { expect, test } from '@playwright/test';

test('production Pagefind search loads its index and returns documentation results', async ({ page }) => {
  const assets: number[] = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.includes('/pagefind/')) assets.push(response.status());
  });
  const response = await page.goto('/features/math/');
  if (!response) throw new Error('Expected a production page response');
  const html = await response.text();
  expect(html).not.toMatch(/search\.devWarning|Search is only available in production builds/u);
  expect(html).toContain('id="starlight__search"');
  await page.locator('site-search button[data-open-modal]').click();
  const dialog = page.getByRole('dialog');
  const input = dialog.locator('.pagefind-ui__search-input');
  await expect(input).toBeVisible();
  await input.fill('logistic');
  await expect(dialog.locator('.pagefind-ui__result-link').first()).toBeVisible();
  expect(assets.length).toBeGreaterThan(0);
  expect(assets.every((status) => status >= 200 && status < 400)).toBe(true);
});
