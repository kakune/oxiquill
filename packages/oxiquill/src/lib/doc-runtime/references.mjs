import YAML from 'yaml';
import { slug as githubSlug } from 'github-slugger';

export const referenceNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function validReferenceName(name) {
  return typeof name === 'string' && name.length <= 64 && referenceNamePattern.test(name);
}

export function referenceError(pagePath, position, message) {
  const line = position?.line ?? 1;
  const column = position?.column ?? 1;
  return Object.assign(new Error(`${pagePath}:${line}:${column} ${message}`), { line, column });
}

export function parsePageFrontmatter(source, pagePath) {
  const match = source.match(/^(?:\uFEFF)?---[^\S\n]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[^\S\n]*(?:\r?\n|$)/u);
  if (!match) return { body: source, frontmatter: {}, references: [] };
  const lineCounter = new YAML.LineCounter();
  const document = YAML.parseDocument(match[1], { lineCounter });
  const position = (node) => {
    const location = lineCounter.linePos(node?.range?.[0] ?? 0);
    return { line: location.line + 1, column: location.col };
  };
  const mapping = document.get('references', true);
  if (YAML.isMap(mapping)) {
    const seen = new Map();
    mapping.items.forEach(({ key }) => {
      const previous = seen.get(key?.value);
      if (previous) {
        const first = position(previous);
        throw referenceError(
          pagePath,
          position(key),
          `Duplicate reference ${JSON.stringify(key.value)}; first declared at ${pagePath}:${first.line}:${first.column}.`
        );
      }
      seen.set(key?.value, key);
    });
  }
  if (document.errors.length) {
    throw referenceError(pagePath, position({ range: document.errors[0].pos }), document.errors[0].message);
  }
  const frontmatter = document.toJS() ?? {};
  if (mapping && !YAML.isMap(mapping)) {
    throw referenceError(
      pagePath,
      position(mapping),
      'references: Expected a mapping of reference names to heading slugs.'
    );
  }
  const references = (mapping?.items ?? []).map(({ key, value }) => {
    const name = key?.value;
    if (!validReferenceName(name)) {
      throw referenceError(
        pagePath,
        position(key),
        'Invalid reference name; expected lowercase kebab-case, at most 64 characters.'
      );
    }
    if (typeof value?.value !== 'string' || !value.value) {
      throw referenceError(pagePath, position(value), `references.${name}: Expected a non-empty heading slug.`);
    }
    return { name, slug: value.value, position: position(key) };
  });
  return { body: match[0].replace(/[^\n]/gu, '') + source.slice(match[0].length), frontmatter, references };
}

export function pageSlug(page) {
  return (
    (page.slug ? String(page.slug) : undefined) ||
    page.entryPath
      .replace(/\.(?:md|mdx)$/u, '')
      .split('/')
      .map((segment) => githubSlug(segment))
      .join('/')
      .replace(/\/index$/u, '')
  );
}

export function pageLocale(page, { i18n } = {}) {
  const locales = i18n?.locales ?? [];
  const paths = locales.map((locale) => (typeof locale === 'string' ? locale : locale.path));
  const defaultPath = i18n?.defaultLocale;
  const prefixDefault = i18n?.routing !== 'manual' && i18n?.routing?.prefixDefaultLocale;
  const first = pageSlug(page).split('/')[0];
  if (paths.includes(first) && (prefixDefault || first !== defaultPath)) return first;
  return prefixDefault ? defaultPath : 'root';
}

export function pageRoute(page, { base = '/', trailingSlash = 'ignore', build = {} } = {}) {
  const slug = pageSlug(page);
  const param = (slug === 'index' || slug === '/' ? '' : slug.replace(/\/index$/u, '')).normalize();
  const prefix = base.replace(/\/$/u, '');
  let pathname = param ? `/${param}/` : '/';
  if (build.format === 'file') {
    const file = pathname.replace(/^\/|\/$/gu, '');
    return `${prefix}/${file.endsWith('.html') ? file : file ? file + '.html' : 'index.html'}`;
  }
  const withoutSlash = pathname.replace(/\/$/u, '');
  if (withoutSlash.endsWith('.html')) pathname = withoutSlash.slice(0, -5);
  const route = `${prefix}/${pathname.replace(/^\//u, '')}`;
  if (trailingSlash === 'always') return route.endsWith('/') ? route : route + '/';
  return trailingSlash === 'never' && route !== '/' ? route.replace(/\/$/u, '') : route;
}

export function createReferenceRegistry(pages, config = {}) {
  const registry = new Map();
  pages.forEach((page) => {
    const locale = pageLocale(page, config);
    [
      ...page.references.map((target) => ({ ...target, kind: 'heading' })),
      ...page.cellReferences.map((target) => ({ ...target, kind: 'cell' }))
    ].forEach((target) => {
      const key = JSON.stringify([locale, target.name]);
      const previous = registry.get(key);
      if (previous) {
        throw referenceError(
          page.pagePath,
          target.position,
          `Duplicate reference ${JSON.stringify(target.name)} in locale ${JSON.stringify(locale)}; first declared at ${previous.pagePath}:${previous.position.line}:${previous.position.column}.`
        );
      }
      registry.set(key, { ...target, locale, route: pageRoute(page, config), pagePath: page.pagePath });
    });
  });
  return registry;
}

export function resolveReference(url, page, registry, config, position) {
  const name = url.slice('oxref:'.length);
  if (/[?#]/u.test(name))
    throw referenceError(page.pagePath, position, 'oxref: links must not contain a fragment or query.');
  if (!validReferenceName(name))
    throw referenceError(
      page.pagePath,
      position,
      'Invalid reference name; expected lowercase kebab-case, at most 64 characters.'
    );
  const locale = pageLocale(page, config);
  const target = registry.get(JSON.stringify([locale, name]));
  if (!target)
    throw referenceError(
      page.pagePath,
      position,
      `Unresolved reference ${JSON.stringify(name)} in locale ${JSON.stringify(locale)}.`
    );
  return `${target.pagePath === page.pagePath ? '' : target.route}#ox-ref-${name}`;
}

// Locations aid diagnostics but never affect reference identity.
export function referencePageIdentity(page) {
  return {
    pagePath: page.pagePath,
    entryPath: page.entryPath,
    slug: page.slug,
    references: page.references.map(({ name, slug }) => ({ name, slug })),
    cellReferences: page.cellReferences.map(({ name, cellId }) => ({ name, cellId })),
    links: page.links,
    headingSignature: page.headingSignature
  };
}
