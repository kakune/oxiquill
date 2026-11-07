import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic';

const fallbackSite = 'https://oxiquill.invalid';

// HTML parsing and link evaluation are pure; only readBuiltSite performs I/O.
export function parseLinkDocument(html) {
  const ids = new Set();
  const links = [];
  let redirect;
  function visit(node) {
    const properties = node.properties ?? {};
    if (properties.id !== undefined) ids.add(String(properties.id));
    if (node.tagName === 'a' && properties.name !== undefined) ids.add(String(properties.name));
    if (['a', 'area'].includes(node.tagName) && properties.href !== undefined) links.push(String(properties.href));
    if (node.tagName === 'meta' && String(properties.httpEquiv).toLowerCase() === 'refresh') {
      const match = String(properties.content).match(/^\s*[\d.]+\s*;\s*url\s*=\s*(.*?)\s*$/iu);
      if (match) redirect = match[1].replace(/^(['"])(.*)\1$/u, '$2');
    }
    node.children?.forEach(visit);
  }
  visit(fromHtmlIsomorphic(html));
  return { ids, links, redirect };
}

function basePath(report) {
  return `/${report.base.split('/').filter(Boolean).join('/')}`;
}

function withinBase(pathname, base) {
  return base === '/' || pathname === base || pathname.startsWith(`${base}/`);
}

export function classifyLink(href, source, report) {
  let url;
  try {
    url = new URL(href, source);
  } catch {
    return { target: href, reason: 'missing-page' };
  }
  const target = url.href;
  if (!['http:', 'https:'].includes(url.protocol)) return { target, skipped: true };
  const absolute = /^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(href.trim());
  const origin = new URL(report.site ?? fallbackSite).origin;
  if (url.origin !== origin || (absolute && !report.site)) return { target, skipped: true };
  if (!withinBase(url.pathname, basePath(report)))
    return absolute ? { target, skipped: true } : { target, reason: 'outside-base' };
  return { target, url };
}

function documentUrl(file, report) {
  let route = file;
  let pageRoute = false;
  if (route === 'index.html') route = '';
  else if (report.build.format === 'directory' && route.endsWith('/index.html')) {
    route = route.slice(0, -11);
    pageRoute = true;
  } else if (report.build.format === 'file') {
    route = route.slice(0, -5);
    pageRoute = true;
  }
  if (route && pageRoute) {
    if (report.trailingSlash === 'always' || (report.trailingSlash === 'ignore' && report.build.format === 'directory'))
      route += '/';
  }
  const base = basePath(report);
  const encodedRoute = route.split('/').map(encodeURIComponent).join('/');
  const pathname =
    !route && base !== '/' && report.trailingSlash === 'never' ? base : `${base === '/' ? '' : base}/${encodedRoute}`;
  return new URL(pathname, report.site ?? fallbackSite).href;
}

function outputFile(url, report, files) {
  let relative;
  try {
    relative = decodeURIComponent(url.pathname.slice(basePath(report) === '/' ? 1 : basePath(report).length)).replace(
      /^\//u,
      ''
    );
  } catch {
    return undefined;
  }
  if (relative.split('/').some((segment) => ['..', '.'].includes(segment)) || relative.includes('\\')) return undefined;
  if (files.has(relative)) return relative;
  if (!relative) return files.has('index.html') ? 'index.html' : undefined;
  const route = relative.replace(/\/$/u, '');
  const candidate = report.build.format === 'file' ? `${route}.html` : `${route}/index.html`;
  return files.has(candidate) ? candidate : undefined;
}

function configuredRedirect(url, report) {
  const base = basePath(report);
  const route = url.pathname.slice(base === '/' ? 0 : base.length) || '/';
  const normalized = route.replace(/\/$/u, '') || '/';
  const entry = report.redirects[route] ?? report.redirects[normalized] ?? report.redirects[`${normalized}/`];
  if (entry !== undefined) return typeof entry === 'string' ? entry : entry.destination;
  // Dynamic redirects can exist without an emitted HTML redirect page.
  for (const [pattern, value] of Object.entries(report.redirects)) {
    const names = [];
    let expression = '';
    let offset = 0;
    for (const token of pattern.replace(/\/$/u, '').matchAll(/\[(\.\.\.)?([^\]]+)\]/gu)) {
      const prefix = pattern.slice(offset, token.index);
      const optionalRest = token[1] && prefix.endsWith('/');
      expression += escapePattern(optionalRest ? prefix.slice(0, -1) : prefix);
      expression += optionalRest ? '(?:/(.*))?' : token[1] ? '(.*)' : '([^/]+)';
      names.push(token[2]);
      offset = token.index + token[0].length;
    }
    if (!names.length) continue;
    expression += escapePattern(pattern.replace(/\/$/u, '').slice(offset));
    const match = normalized.match(new RegExp(`^${expression}$`, 'u'));
    if (!match) continue;
    const parameters = Object.fromEntries(names.map((name, index) => [name, match[index + 1] ?? '']));
    const destination = typeof value === 'string' ? value : value.destination;
    return destination
      .replace(/\/\[\.\.\.([^\]]+)\]/gu, (_, name) => (parameters[name] ? `/${parameters[name]}` : ''))
      .replace(/\[(?:\.\.\.)?([^\]]+)\]/gu, (_, name) => parameters[name] ?? '');
  }
  return undefined;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function evaluateLink(href, source, report, files, documents) {
  let current = classifyLink(href, source, report);
  const visited = new Set();
  while (current.url) {
    const { url, target } = current;
    const key = `${url.origin}${url.pathname}${url.search}`;
    if (visited.has(key) || visited.size >= 100) return { target, reason: 'redirect-loop' };
    visited.add(key);
    const file = outputFile(url, report, files);
    const document = documents.get(file);
    const redirect = document?.redirect ?? configuredRedirect(url, report);
    const page = file?.endsWith('.html') || redirect !== undefined;
    if (page && !url.pathname.endsWith('.html') && url.pathname !== '/') {
      const slash = url.pathname.endsWith('/');
      if ((report.trailingSlash === 'always' && !slash) || (report.trailingSlash === 'never' && slash))
        return { target, reason: 'trailing-slash' };
    }
    if (redirect !== undefined) {
      const next = classifyLink(redirect, target, report);
      if (next.url && !redirect.includes('#')) {
        next.url.hash = url.hash;
        next.target = next.url.href;
      }
      current = next;
      continue;
    }
    if (!file) return { target, reason: 'missing-page' };
    if (!document) return { target };
    let fragment;
    try {
      fragment = decodeURIComponent(url.hash.slice(1));
    } catch {
      return { target, reason: 'missing-fragment' };
    }
    return fragment && fragment !== 'top' && !document.ids.has(fragment)
      ? { target, reason: 'missing-fragment' }
      : { target };
  }
  return current;
}

export function checkBuiltLinks(report, entries) {
  const files = new Set(entries.map(({ file }) => file));
  const documents = new Map(entries.filter(({ document }) => document).map(({ file, document }) => [file, document]));
  const failures = new Map();
  let checked = 0;
  let skipped = 0;
  let occurrences = 0;
  for (const [file, document] of documents) {
    const source = documentUrl(file, report);
    for (const href of document.links) {
      const result = evaluateLink(href, source, report, files, documents);
      if (result.skipped) skipped += 1;
      else checked += 1;
      if (!result.reason) continue;
      occurrences += 1;
      const key = JSON.stringify([result.target, result.reason]);
      const previous = failures.get(key);
      const example = { source, href };
      failures.set(key, {
        type: 'link-failure',
        target: result.target,
        reason: result.reason,
        count: (previous?.count ?? 0) + 1,
        examples: previous
          ? previous.examples.length < 5 && !previous.examples.some((entry) => entry.source === source)
            ? [...previous.examples, example]
            : previous.examples
          : [example]
      });
    }
  }
  return {
    failures: [...failures.values()].sort(
      (a, b) => a.target.localeCompare(b.target) || a.reason.localeCompare(b.reason)
    ),
    totals: { pages: documents.size, checked, skipped, failures: failures.size, occurrences }
  };
}

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = `${prefix}${entry.name}`;
      return entry.isDirectory() ? listFiles(path.join(directory, entry.name), `${file}/`) : [file];
    })
  );
  return nested.flat().sort();
}

export async function readBuiltSite(cacheDir) {
  try {
    const report = JSON.parse(await readFile(path.join(cacheDir, 'build-report.json'), 'utf8'));
    if (
      !path.isAbsolute(report.outDir) ||
      !['directory', 'file'].includes(report.build?.format) ||
      !['always', 'never', 'ignore'].includes(report.trailingSlash) ||
      typeof report.base !== 'string' ||
      !report.redirects ||
      typeof report.redirects !== 'object'
    )
      throw new Error('Invalid build report.');
    if (report.site !== null) new URL(report.site);
    const files = await listFiles(report.outDir);
    if (!files.some((file) => file.endsWith('.html'))) throw new Error('No built HTML pages found.');
    const entries = await Promise.all(
      files.map(async (file) => ({
        file,
        ...(file.endsWith('.html')
          ? { document: parseLinkDocument(await readFile(path.join(report.outDir, file), 'utf8')) }
          : {})
      }))
    );
    return { report, entries };
  } catch (cause) {
    throw new Error('Unable to read the built site. Run oxiquill build first.', { cause });
  }
}

export async function runLinkCheck({ paths, events }) {
  const { report, entries } = await readBuiltSite(paths.cacheDir);
  const result = checkBuiltLinks(report, entries);
  events.linkCheck = result.totals;
  result.failures.forEach(events.report);
  if (result.failures.length) throw new Error(`Found ${result.failures.length} broken local link target(s).`);
  return result;
}
