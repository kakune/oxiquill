/**
 * Route-data helpers for `missingTranslations: 'omit'`.
 *
 * Starlight generates a fallback page for every default-locale page that lacks a translation. In
 * omit mode Oxiquill removes those routes before generation, so navigation that Starlight derives
 * from its full route list must stop pointing at them. The helpers mirror Starlight 0.42's own
 * slug, URL, and pagination rules and operate on plain route data so they stay testable.
 */

export interface TranslationIndex {
  /** Ids of generated documentation routes, excluding fallback routes. */
  readonly routeIds: ReadonlySet<string>;
  /** Ids of the fallback routes that Starlight would otherwise generate. */
  readonly fallbackRouteIds: ReadonlySet<string>;
  readonly locales: Readonly<Record<string, { readonly label: string; readonly lang?: string }>>;
  /** Default locale directory, or `undefined` when the root locale is the default. */
  readonly defaultLocale: string | undefined;
  readonly pagination: boolean;
  readonly trailingSlash: 'always' | 'never' | 'ignore';
  readonly base: string;
}

export interface SidebarLinkData {
  readonly type: 'link';
  readonly label: string;
  readonly href: string;
  readonly isCurrent: boolean;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface SidebarGroupData {
  readonly type: 'group';
  readonly entries: readonly SidebarEntryData[];
  readonly [key: string]: unknown;
}

export type SidebarEntryData = SidebarLinkData | SidebarGroupData;

type PrevNextConfig = boolean | string | { readonly link?: string; readonly label?: string } | undefined;

export interface PaginationData {
  prev: SidebarLinkData | undefined;
  next: SidebarLinkData | undefined;
}

export interface HeadEntryData {
  readonly tag: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface TranslatableRouteData {
  id: string;
  locale: string | undefined;
  entry: { readonly data: { readonly prev?: PrevNextConfig; readonly next?: PrevNextConfig } };
  sidebar: SidebarEntryData[];
  pagination: PaginationData;
  head: HeadEntryData[];
  siteTitleHref: string;
}

export interface LanguageOption {
  readonly label: string;
  readonly value: string;
  readonly selected: boolean;
}

const localOrigin = 'https://oxiquill.invalid';

function stripTrailingSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

function decodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Converts a site pathname to a Starlight route id, following Starlight's `urlToSlug`. */
export function routeIdFromPathname(pathname: string, base: string): string | undefined {
  const prefix = stripTrailingSlash(base);
  let path = decodePath(pathname);
  if (prefix) {
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined;
    path = path.slice(prefix.length);
  }
  const segments = path.split('/');
  const last = segments.at(-1);
  if (last === 'index.html') segments.pop();
  else if (last?.endsWith('.html')) segments.splice(-1, 1, last.slice(0, -5));
  return segments.filter(Boolean).join('/').normalize();
}

/** Converts a same-site link to a route id. External links and links outside the base have none. */
export function routeIdFromHref(href: string, base: string, site?: URL | string): string | undefined {
  let url: URL;
  try {
    url = new URL(href, localOrigin);
  } catch {
    return undefined;
  }
  if (url.origin !== localOrigin && (site === undefined || url.origin !== new URL(site).origin)) return undefined;
  return routeIdFromPathname(url.pathname, base);
}

function slugLocale(slug: string, index: Pick<TranslationIndex, 'locales' | 'defaultLocale'>): string | undefined {
  const baseSegment = slug.split('/')[0];
  if (baseSegment && Object.hasOwn(index.locales, baseSegment)) return baseSegment;
  return Object.hasOwn(index.locales, 'root') ? undefined : index.defaultLocale;
}

/** Returns the id of the same page in another locale (`undefined` is the root locale). */
export function localizedRouteId(
  id: string,
  locale: string | undefined,
  index: Pick<TranslationIndex, 'locales' | 'defaultLocale'>
): string {
  const current = slugLocale(id, index);
  if (current === locale) return id;
  const target = locale ?? '';
  if (current === id) return target;
  if (current) return stripTrailingSlash(id.replace(`${current}/`, target ? `${target}/` : ''));
  return id ? `${target ? `${target}/` : ''}${id}` : target;
}

/** Returns the current pathname in another locale, following Starlight's `localizedUrl`. */
export function localizedPathname(
  pathname: string,
  locale: string,
  index: Pick<TranslationIndex, 'base' | 'locales' | 'trailingSlash'>
): string {
  const target = locale === 'root' ? '' : locale;
  const base = stripTrailingSlash(index.base);
  const hasBase = pathname.startsWith(base);
  let path = hasBase ? pathname.slice(base.length) : pathname;
  const baseSegment = path.split('/')[1];
  const isRootHtml = baseSegment?.endsWith('.html') ?? false;
  const baseSlug = isRootHtml ? baseSegment?.slice(0, -5) : baseSegment;

  if (baseSlug && Object.hasOwn(index.locales, baseSlug)) {
    if (target) path = path.replace(baseSlug, target);
    else if (isRootHtml) path = '/index.html';
    else path = path.replace(`/${baseSlug}`, '');
  } else if (target) {
    path = baseSegment === 'index.html' ? `/${target}.html` : `/${target}${path}`;
  }
  if (hasBase) path = `${base}${path}`;
  if (index.trailingSlash === 'never') path = stripTrailingSlash(path);
  return path || '/';
}

/** Removes links that pass `remove` and the groups that become empty because of it. */
export function filterSidebar(
  entries: readonly SidebarEntryData[],
  remove: (link: SidebarLinkData) => boolean
): SidebarEntryData[] {
  return entries.flatMap((entry): SidebarEntryData[] => {
    if (entry.type === 'link') return remove(entry) ? [] : [entry];
    const children = filterSidebar(entry.entries, remove);
    return entry.entries.length > 0 && children.length === 0 ? [] : [{ ...entry, entries: children }];
  });
}

function flattenSidebar(entries: readonly SidebarEntryData[]): SidebarLinkData[] {
  return entries.flatMap((entry) => (entry.type === 'link' ? [entry] : flattenSidebar(entry.entries)));
}

// Starlight's `applyPrevNextLinkConfig`, applied to the filtered neighbor. A custom destination
// without a generated neighbor is kept as Starlight resolved it.
function applyPrevNextConfig(
  link: SidebarLinkData | undefined,
  original: SidebarLinkData | undefined,
  paginationEnabled: boolean,
  config: PrevNextConfig
): SidebarLinkData | undefined {
  if (config === false) return undefined;
  if (config === true) return link;
  if (typeof config === 'string') return link ? { ...link, label: config } : undefined;
  if (typeof config === 'object' && config !== null) {
    if (link) return { ...link, label: config.label ?? link.label, href: config.link ?? link.href, attrs: {} };
    return config.link && config.label ? original : undefined;
  }
  return paginationEnabled ? link : undefined;
}

/** Recomputes previous and next links from a filtered sidebar. */
export function paginationLinks(
  sidebar: readonly SidebarEntryData[],
  original: PaginationData,
  paginationEnabled: boolean,
  config: { readonly prev?: PrevNextConfig; readonly next?: PrevNextConfig }
): PaginationData {
  const links = flattenSidebar(sidebar);
  const current = links.findIndex((link) => link.isCurrent);
  return {
    prev: applyPrevNextConfig(links[current - 1], original.prev, paginationEnabled, config.prev),
    next: applyPrevNextConfig(
      current > -1 ? links[current + 1] : undefined,
      original.next,
      paginationEnabled,
      config.next
    )
  };
}

/** Lists only the locales that have this page, with Starlight's language-select values. */
export function languageOptions(
  route: Pick<TranslatableRouteData, 'id' | 'locale'>,
  pathname: string,
  index: TranslationIndex
): LanguageOption[] {
  const current = route.locale ?? 'root';
  return Object.entries(index.locales).flatMap(([code, locale]) => {
    const id = localizedRouteId(route.id, code === 'root' ? undefined : code, index);
    if (code !== current && !index.routeIds.has(id)) return [];
    return [{ label: locale.label, value: localizedPathname(pathname, code, index), selected: code === current }];
  });
}

/** Removes navigation and language alternates that point at omitted fallback routes. */
export function applyTranslatedRouteData(route: TranslatableRouteData, index: TranslationIndex, site?: URL): void {
  const routeId = (href: string) => routeIdFromHref(href, index.base, site);
  const isFallback = (href: string) => {
    const id = routeId(href);
    return id !== undefined && index.fallbackRouteIds.has(id);
  };

  route.sidebar = filterSidebar(route.sidebar, (link) => isFallback(link.href));
  route.pagination = paginationLinks(route.sidebar, route.pagination, index.pagination, route.entry.data);
  route.head = route.head.filter((entry) => {
    if (entry.tag !== 'link' || entry.attrs?.rel !== 'alternate' || entry.attrs.hreflang === undefined) return true;
    const href = entry.attrs.href;
    const id = typeof href === 'string' ? routeId(href) : undefined;
    return id === undefined || index.routeIds.has(id);
  });
  if (isFallback(route.siteTitleHref)) {
    route.siteTitleHref = localizedPathname(route.siteTitleHref, index.defaultLocale ?? 'root', index);
  }
}
