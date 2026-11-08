import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves `docRedirects` into Astro `redirects`.
 *
 * Astro matches redirect sources below `base`, but it cannot tell that a destination served by
 * Starlight's dynamic docs route is a project route, so it leaves such destinations unprefixed.
 * Doc redirect destinations are base-relative documentation paths; Oxiquill adds the base.
 */
export function resolveDocRedirects(docRedirects, { base, redirects } = {}) {
  if (docRedirects === undefined) return { redirects, targets: [] };
  if (!isRecord(docRedirects)) throw new TypeError('docRedirects must be an object of source paths to destinations.');

  const prefix = String(base ?? '').replace(/\/+$/u, '');
  const merged = { ...(redirects ?? {}) };
  const targets = [];
  for (const [source, value] of Object.entries(docRedirects)) {
    if (Object.hasOwn(merged, source)) {
      throw new TypeError(`docRedirects source ${source} is also configured in redirects.`);
    }
    const destination = typeof value === 'string' ? value : isRecord(value) ? value.destination : undefined;
    if (!isDocumentPath(destination)) {
      throw new TypeError(
        `docRedirects destination for ${source} must be a base-relative documentation path such as /guides/start/.`
      );
    }
    merged[source] =
      typeof value === 'string' ? `${prefix}${destination}` : { ...value, destination: `${prefix}${destination}` };
    targets.push(destination);
  }
  return { redirects: merged, targets };
}

/** Returns doc redirect destinations that did not produce an HTML page in the build output. */
export async function missingDocRedirectTargets(outputDirectory, targets) {
  const root = fileURLToPath(outputDirectory);
  const missing = [];
  for (const target of targets) {
    const found = await Promise.any(
      targetFiles(target).map((file) => access(path.join(root, ...file.split('/'))))
    ).then(
      () => true,
      () => false
    );
    if (!found) missing.push(target);
  }
  return missing;
}

function targetFiles(target) {
  const route = decodeURI(target.replace(/[?#].*$/u, '')).replace(/^\/+/u, '');
  if (route === '') return ['index.html'];
  if (route.endsWith('.html')) return [route];
  const directory = route.replace(/\/+$/u, '');
  return [`${directory}/index.html`, `${directory}.html`];
}

function isDocumentPath(value) {
  return typeof value === 'string' && /^\/(?!\/)[^[\]\\]*$/u.test(value);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
