import { expect, test, type Page } from '@playwright/test';

// Built by tests/e2e/locale-routing-server.mjs from tests/fixtures/locale-routing.
const root = 'http://127.0.0.1:4326/localized/';

function sidebarLinks(page: Page) {
  return page.locator('#starlight__sidebar a').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
}

test('omits untranslated Japanese pages from routes and the sitemap', async ({ request }) => {
  for (const path of ['ja/english-only/', 'ja/notes/'])
    expect((await request.get(`${root}${path}`)).status()).toBe(404);
  for (const path of ['english-only/', 'ja/guide/', 'ja/wide/'])
    expect((await request.get(`${root}${path}`)).ok()).toBe(true);

  const sitemap = await (await request.get(`${root}sitemap-0.xml`)).text();
  expect(sitemap).toContain('/localized/english-only/');
  expect(sitemap).not.toContain('/localized/ja/english-only/');
  expect(sitemap).not.toContain('/localized/ja/notes/');
});

test('Japanese navigation links only translated pages', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${root}ja/guide/`);

  expect(await sidebarLinks(page)).toEqual(['/localized/ja/', '/localized/ja/guide/', '/localized/ja/wide/']);
  await expect(page.locator('#starlight__sidebar')).not.toContainText('ノート');
  await expect(page.locator('.pagination-links a[rel="next"]')).toHaveAttribute('href', '/localized/ja/wide/');
  await expect(page.locator('.pagination-links a[rel="prev"]')).toHaveAttribute('href', '/localized/ja/');
  await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(3);

  const select = page.locator('header oxiquill-language-select select');
  await expect(select.locator('option')).toHaveText(['English', '日本語']);
  await expect(select).toHaveValue('/localized/ja/guide/');
  await select.selectOption({ label: 'English' });
  await expect(page).toHaveURL(`${root}guide/`);
});

test('pages without a translation hide the language select and alternates', async ({ page }) => {
  await page.goto(`${root}english-only/`);

  await expect(page.getByRole('heading', { name: 'English only', level: 1 })).toBeVisible();
  await expect(page.locator('oxiquill-language-select')).toHaveCount(0);
  await expect(page.locator('link[rel="alternate"][hreflang="ja"]')).toHaveCount(0);
  expect(await sidebarLinks(page)).toContain('/localized/notes/');
});

test('doc redirects resolve below the base path', async ({ page }) => {
  await page.goto(`${root}ja/old-guide/`);
  await expect(page).toHaveURL(`${root}ja/guide/`);
  await expect(page.getByRole('heading', { name: 'ガイド', level: 1 })).toBeVisible();
});

test('full-width pages use the pane width beside both navigation columns', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const measure = () =>
    page.evaluate(() => {
      const element = (selector: string) => {
        const match = document.querySelector(selector);
        if (!match) throw new Error(`Missing ${selector}`);
        return match;
      };
      const box = (selector: string) => element(selector).getBoundingClientRect();
      const container = box('.main-pane .content-panel:last-of-type > .sl-container');
      const panel = element('.main-pane .content-panel:last-of-type');
      const padding = getComputedStyle(panel);
      const toc = box('.right-sidebar-container');
      const toggle = box('.table-of-contents-toggle-button');
      return {
        container: container.width,
        panelContent: panel.clientWidth - parseFloat(padding.paddingLeft) - parseFloat(padding.paddingRight),
        tocLeft: toc.left,
        toggle: toggle.left + toggle.width / 2
      };
    });

  await page.goto(`${root}guide/`);
  const measured = await measure();
  expect(measured.container).toBeLessThanOrEqual(720.5);

  await page.goto(`${root}wide/`);
  const wide = await measure();
  expect(wide.container).toBeGreaterThan(measured.container + 100);
  expect(Math.abs(wide.panelContent - wide.container)).toBeLessThanOrEqual(1);
  expect(Math.abs(wide.toggle - wide.tocLeft)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(
    0
  );

  await page.locator('starlight-table-of-contents-toggle button').click();
  await expect(page.locator('html')).toHaveAttribute('data-table-of-contents-collapsed', '');
  const collapsed = await page.locator('.main-pane .content-panel:last-of-type > .sl-container').boundingBox();
  expect(collapsed?.width).toBeGreaterThan(wide.container);
});

test('long table-of-contents entries wrap inside the column', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const path of ['guide/', 'ja/guide/']) {
    await page.goto(`${root}${path}`);
    const overflow = await page.locator('.right-sidebar-panel a').evaluateAll((links) =>
      links.map((link) => {
        const panel = link.closest('.right-sidebar-panel')?.getBoundingClientRect();
        return panel ? link.getBoundingClientRect().right - panel.right : Infinity;
      })
    );
    expect(Math.max(...overflow)).toBeLessThanOrEqual(0);
  }
});

test('the Japanese stylesheet applies strict line breaking only to Japanese pages', async ({ page }) => {
  const typography = () =>
    page.locator('.sl-markdown-content').evaluate((content) => {
      const paragraph = content.querySelector('p');
      if (!paragraph) throw new Error('Missing paragraph');
      const style = getComputedStyle(paragraph);
      return {
        lineBreak: getComputedStyle(content).lineBreak,
        lineHeight: parseFloat(style.lineHeight) / parseFloat(style.fontSize)
      };
    });

  await page.goto(`${root}ja/guide/`);
  const japanese = await typography();
  expect(japanese.lineBreak).toBe('strict');
  expect(japanese.lineHeight).toBeCloseTo(1.9, 1);

  await page.goto(`${root}guide/`);
  expect((await typography()).lineBreak).toBe('auto');
});
