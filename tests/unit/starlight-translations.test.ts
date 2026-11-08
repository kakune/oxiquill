// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  applyTranslatedRouteData,
  filterSidebar,
  languageOptions,
  localizedPathname,
  localizedRouteId,
  paginationLinks,
  routeIdFromHref,
  routeIdFromPathname,
  type SidebarEntryData,
  type SidebarLinkData,
  type TranslatableRouteData,
  type TranslationIndex
} from '../../packages/oxiquill/src/lib/starlight/translations';
import {
  starlightTranslationsModule,
  starlightTranslationsPlugin
} from '../../packages/oxiquill/src/astro/starlight-translations.mjs';
import { missingDocRedirectTargets } from '../../packages/oxiquill/src/config/doc-redirects.mjs';
import { onRequest } from '../../packages/oxiquill/src/components/starlight/translation-route-middleware';

const rootIndex: TranslationIndex = {
  routeIds: new Set(['', 'guide', 'english-only', 'ja', 'ja/guide']),
  fallbackRouteIds: new Set(['ja/english-only']),
  locales: { root: { label: 'English', lang: 'en' }, ja: { label: '日本語', lang: 'ja' } },
  defaultLocale: undefined,
  pagination: true,
  trailingSlash: 'ignore',
  base: '/docs/'
};

function link(label: string, href: string, isCurrent = false): SidebarLinkData {
  return { type: 'link', label, href, isCurrent, attrs: {}, badge: undefined };
}

function route(id: string, locale: string | undefined, sidebar: SidebarEntryData[]): TranslatableRouteData {
  return {
    id,
    locale,
    entry: { data: {} },
    sidebar,
    pagination: { prev: undefined, next: undefined },
    head: [],
    siteTitleHref: locale ? `/docs/${locale}/` : '/docs/'
  };
}

describe('Starlight route ids', () => {
  it.each([
    ['/docs/', ''],
    ['/docs', ''],
    ['/docs/ja/guide/', 'ja/guide'],
    ['/docs/ja/guide.html', 'ja/guide'],
    ['/docs/ja/index.html', 'ja'],
    ['/docs/%E6%97%A5%E6%9C%AC/', '日本'],
    ['/elsewhere/ja/', undefined],
    ['/docsy/', undefined]
  ])('maps %s to %j', (pathname, id) => {
    expect(routeIdFromPathname(pathname, '/docs/')).toBe(id);
  });

  it('ignores external links unless they use the site origin', () => {
    expect(routeIdFromHref('https://example.com/docs/ja/', '/docs/')).toBeUndefined();
    expect(routeIdFromHref('https://example.com/docs/ja/', '/docs/', new URL('https://example.com'))).toBe('ja');
    expect(routeIdFromHref('/docs/guide/#part', '/docs/')).toBe('guide');
    expect(routeIdFromHref('http://[invalid', '/')).toBeUndefined();
    expect(routeIdFromPathname('/%E0%A4%A/', '/')).toBe('%E0%A4%A');
  });

  it('localizes ids for root and directory default locales', () => {
    expect(localizedRouteId('guide', 'ja', rootIndex)).toBe('ja/guide');
    expect(localizedRouteId('ja/guide', undefined, rootIndex)).toBe('guide');
    expect(localizedRouteId('', 'ja', rootIndex)).toBe('ja');
    expect(localizedRouteId('ja', undefined, rootIndex)).toBe('');
    expect(localizedRouteId('ja/guide', 'ja', rootIndex)).toBe('ja/guide');

    const directories = { locales: { en: { label: 'English' }, ja: { label: '日本語' } }, defaultLocale: 'en' };
    expect(localizedRouteId('en/guide', 'ja', directories)).toBe('ja/guide');
    expect(localizedRouteId('en', 'ja', directories)).toBe('ja');
    // Like Starlight, a slug outside every locale directory keeps its id.
    expect(localizedRouteId('loose', 'ja', directories)).toBe('loose');
  });

  it('localizes pathnames like Starlight', () => {
    expect(localizedPathname('/docs/guide/', 'ja', rootIndex)).toBe('/docs/ja/guide/');
    expect(localizedPathname('/docs/ja/guide/', 'root', rootIndex)).toBe('/docs/guide/');
    expect(localizedPathname('/docs/ja/', 'root', rootIndex)).toBe('/docs/');
    expect(localizedPathname('/docs/ja.html', 'root', rootIndex)).toBe('/docs/index.html');
    expect(localizedPathname('/docs/index.html', 'ja', rootIndex)).toBe('/docs/ja.html');
    expect(localizedPathname('/ja/guide/', 'root', { ...rootIndex, base: '/' })).toBe('/guide/');
    expect(localizedPathname('/ja', 'root', { ...rootIndex, base: '/' })).toBe('/');
    expect(localizedPathname('/docs/guide/', 'ja', { ...rootIndex, trailingSlash: 'never' })).toBe('/docs/ja/guide');
  });
});

describe('translated navigation', () => {
  const sidebar: SidebarEntryData[] = [
    {
      type: 'group',
      label: 'Docs',
      entries: [link('Guide', '/docs/ja/guide/', true), link('English only', '/docs/ja/english-only/')]
    },
    { type: 'group', label: 'Only fallbacks', entries: [link('English only', '/docs/ja/english-only/')] },
    { type: 'group', label: 'Empty by design', entries: [] },
    link('GitHub', 'https://github.com/')
  ];

  it('drops fallback links and the groups they empty', () => {
    const filtered = filterSidebar(sidebar, (entry) => entry.href.includes('english-only'));
    expect(filtered.map((entry) => entry.label)).toEqual(['Docs', 'Empty by design', 'GitHub']);
    expect(filtered[0]).toMatchObject({ entries: [{ label: 'Guide' }] });
  });

  it('follows Starlight pagination settings on the filtered sidebar', () => {
    const links = [link('A', '/a/'), link('B', '/b/', true), link('C', '/c/')];
    const original = { prev: link('Old', '/old/'), next: link('Custom', '/custom/') };

    expect(paginationLinks(links, original, true, {})).toEqual({ prev: links[0], next: links[2] });
    expect(paginationLinks(links, original, false, {})).toEqual({ prev: undefined, next: undefined });
    expect(paginationLinks(links, original, false, { prev: true, next: false })).toEqual({
      prev: links[0],
      next: undefined
    });
    expect(paginationLinks(links, original, true, { prev: 'Back', next: { label: 'Onward' } })).toEqual({
      prev: { ...links[0], label: 'Back' },
      next: { ...links[2], label: 'Onward', attrs: {} }
    });
    expect(paginationLinks(links, original, true, { next: { link: '/custom/' } }).next).toMatchObject({
      label: 'C',
      href: '/custom/'
    });

    const last = [link('A', '/a/'), link('B', '/b/', true)];
    expect(paginationLinks(last, original, true, { next: { link: '/custom/', label: 'Custom' } }).next).toBe(
      original.next
    );
    expect(paginationLinks(last, original, true, { next: { link: '/custom/' } }).next).toBeUndefined();
    expect(paginationLinks(last, original, true, { next: 'Label' }).next).toBeUndefined();
    expect(paginationLinks([link('A', '/a/')], original, true, {})).toEqual({ prev: undefined, next: undefined });
  });

  it('applies filtered sidebar, pagination, alternates, and site title to route data', () => {
    const data = route('ja/guide', 'ja', [
      link('Guide', '/docs/ja/guide/', true),
      link('English only', '/docs/ja/english-only/'),
      link('Next', '/docs/ja/')
    ]);
    data.head = [
      { tag: 'link', attrs: { rel: 'alternate', hreflang: 'en', href: 'https://example.com/docs/guide/' } },
      { tag: 'link', attrs: { rel: 'alternate', hreflang: 'ja', href: 'https://example.com/docs/ja/missing/' } },
      { tag: 'link', attrs: { rel: 'alternate', hreflang: 'x-default', href: 42 } },
      { tag: 'link', attrs: { rel: 'canonical', href: 'https://example.com/docs/ja/missing/' } },
      { tag: 'meta', attrs: { name: 'generator' } }
    ];

    applyTranslatedRouteData(data, rootIndex, new URL('https://example.com'));

    expect(data.sidebar.map((entry) => entry.label)).toEqual(['Guide', 'Next']);
    expect(data.pagination.next).toMatchObject({ label: 'Next' });
    expect(data.head.map((entry) => entry.attrs?.hreflang ?? entry.tag)).toEqual(['en', 'x-default', 'link', 'meta']);
    expect(data.siteTitleHref).toBe('/docs/ja/');

    const untranslatedHome = route('ja/guide', 'ja', []);
    applyTranslatedRouteData(untranslatedHome, { ...rootIndex, fallbackRouteIds: new Set(['ja']) });
    expect(untranslatedHome.siteTitleHref).toBe('/docs/');
  });

  it('offers only locales that have the current page', () => {
    expect(languageOptions({ id: 'guide', locale: undefined }, '/docs/guide/', rootIndex)).toEqual([
      { label: 'English', value: '/docs/guide/', selected: true },
      { label: '日本語', value: '/docs/ja/guide/', selected: false }
    ]);
    expect(languageOptions({ id: 'english-only', locale: undefined }, '/docs/english-only/', rootIndex)).toEqual([
      { label: 'English', value: '/docs/english-only/', selected: true }
    ]);
    expect(languageOptions({ id: 'ja/guide', locale: 'ja' }, '/docs/ja/guide/', rootIndex)).toEqual([
      { label: 'English', value: '/docs/guide/', selected: false },
      { label: '日本語', value: '/docs/ja/guide/', selected: true }
    ]);
  });
});

describe('Starlight translations plugin', () => {
  const staticRoute = '/repo/node_modules/@astrojs/starlight/dist/routes/static/index.astro';

  it('answers only the static docs route routing import', () => {
    const { plugin, wasStaticRouteIntercepted } = starlightTranslationsPlugin();
    const resolveId = plugin.resolveId as (source: string, importer?: string) => string | undefined;

    expect(resolveId('virtual:oxiquill/starlight-translations')).toBe('\0virtual:oxiquill/starlight-translations');
    expect(wasStaticRouteIntercepted()).toBe(false);
    expect(resolveId('../../utils/routing', '/repo/node_modules/@astrojs/starlight/dist/routes/ssr/index.astro')).toBe(
      undefined
    );
    expect(resolveId('../../utils/routing/data', staticRoute)).toBeUndefined();
    expect(resolveId('../../utils/routing')).toBeUndefined();
    expect(resolveId('../../utils/routing', `${staticRoute}?astro&type=script`)).toBe(
      '\0virtual:oxiquill/starlight-translations'
    );
    expect(wasStaticRouteIntercepted()).toBe(true);
  });

  it("loads Starlight's routing module through the public static route export", async () => {
    const { plugin } = starlightTranslationsPlugin();
    const resolve = vi.fn(async (source: string): Promise<{ id: string } | null> =>
      source.startsWith('@astrojs') ? { id: staticRoute } : { id: '/repo/starlight/utils/routing/index.js' }
    );
    const load = plugin.load as (this: { resolve: typeof resolve }, id: string) => Promise<string | undefined>;

    expect(await load.call({ resolve }, 'other')).toBeUndefined();
    const code = await load.call({ resolve }, '\0virtual:oxiquill/starlight-translations');
    expect(resolve).toHaveBeenCalledWith('../../utils/routing', staticRoute, { skipSelf: true });
    expect(code).toBe(starlightTranslationsModule('/repo/starlight/utils/routing/index.js'));
    expect(code).toContain('export const paths = starlightPaths.filter');

    await expect(
      load.call({ resolve: vi.fn(async () => null) }, '\0virtual:oxiquill/starlight-translations')
    ).rejects.toThrow("Oxiquill could not locate Starlight's routing module");
  });
});

describe('doc redirect targets', () => {
  it('reports destinations without a generated page', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-redirects-'));
    try {
      await mkdir(path.join(root, 'ja/guide'), { recursive: true });
      await writeFile(path.join(root, 'index.html'), '');
      await writeFile(path.join(root, 'ja/guide/index.html'), '');
      await writeFile(path.join(root, 'flat.html'), '');
      await writeFile(path.join(root, '日本.html'), '');

      expect(
        await missingDocRedirectTargets(pathToFileURL(`${root}/`), [
          '/',
          '/ja/guide/',
          '/ja/guide#intro',
          '/flat/',
          '/flat.html',
          '/%E6%97%A5%E6%9C%AC/',
          '/missing/',
          '/missing.html'
        ])
      ).toEqual(['/missing/', '/missing.html']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('translation route middleware', () => {
  it('filters Starlight route data before later middleware runs', async () => {
    const starlightRoute = route('ja/guide', 'ja', [
      link('Guide', '/ja/guide/', true),
      link('English only', '/ja/english-only/')
    ]);
    starlightRoute.siteTitleHref = '/ja/';
    const seen: string[][] = [];
    const next = vi.fn(async () => {
      seen.push(starlightRoute.sidebar.map((entry) => String(entry.label)));
    });

    await onRequest({ locals: { starlightRoute } }, next);
    expect(seen).toEqual([['Guide']]);
    expect(starlightRoute.pagination).toEqual({ prev: undefined, next: undefined });

    const withoutRoute = vi.fn(async () => undefined);
    await onRequest({ locals: {} }, withoutRoute);
    expect(withoutRoute).toHaveBeenCalledOnce();
  });
});
