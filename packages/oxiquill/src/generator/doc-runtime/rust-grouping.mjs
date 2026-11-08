import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { hashText } from './hashing.mjs';
import { normalizePath } from './path-utils.mjs';

export const RUST_GROUP_KEY_MAX_LENGTH = 256;
export const RUST_GROUP_MODES = Object.freeze(['page', 'directory', 'site', 'custom']);
// Short ids keep Cargo's target paths (`.fingerprint/<package>-<hash>/lib-<crate>.json`)
// below the Windows MAX_PATH limit; 64 bits remain ample for authored keys.
const ID_HASH_LENGTH = 16;
const SITE_KEY = 'site';

export function rustGroupMode(grouping = 'page') {
  if (typeof grouping === 'function') return 'custom';
  if (['page', 'directory', 'site'].includes(grouping)) return grouping;
  throw new TypeError("rust.grouping must be 'page', 'directory', 'site', or a function ({ path }) => string.");
}

// POSIX, docs-relative, locale prefix included, and NFC so that NFD file systems
// (macOS HFS+) and NFC checkouts derive the same group keys.
export function rustDocsPagePath(pagePath, paths) {
  const absolute = path.resolve(pathFromUrl(paths.workspaceRoot), normalizePath(String(pagePath)));
  return normalizePath(path.relative(pathFromUrl(paths.docsDir), absolute)).normalize('NFC');
}

export function rustPageKey(pagePath, grouping = 'page') {
  const mode = rustGroupMode(grouping);
  if (mode === 'page') return { mode, key: pagePath };
  if (mode === 'directory') return { mode, key: path.posix.dirname(pagePath) };
  if (mode === 'site') return { mode, key: SITE_KEY };
  let value;
  try {
    value = grouping(Object.freeze({ path: pagePath }));
  } catch (cause) {
    throw new Error(`rust.grouping function failed for page ${pagePath}: ${errorMessage(cause)}`, { cause });
  }
  if (typeof value?.then === 'function')
    throw new TypeError(
      `rust.grouping function returned a promise for page ${pagePath}; return the group key synchronously.`
    );
  // Lone surrogates hash like U+FFFD, so malformed keys could silently merge groups.
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !value.isWellFormed() ||
    Array.from(value).length > RUST_GROUP_KEY_MAX_LENGTH
  )
    throw new TypeError(
      `rust.grouping function returned ${describe(value)} for page ${pagePath}; expected a non-empty string of at most ${RUST_GROUP_KEY_MAX_LENGTH} characters.`
    );
  return { mode, key: value.normalize('NFC') };
}

export function rustGroupId(mode, key) {
  return `${mode}-${hashText(key).slice(0, ID_HASH_LENGTH)}`;
}

export function rustGroupPackage(id) {
  return Object.freeze({ packageName: `doc-rust-${id}`, crateName: `doc_rust_${id.replaceAll('-', '_')}` });
}

// Each page belongs to exactly one group, so page-local definitions, uses, and
// data dependencies never cross a module boundary. The grouping function runs
// once per page that has Rust cells.
export function assignRustGroups({ cells, paths, grouping = 'page', groupId = rustGroupId }) {
  const pages = new Map();
  for (const cell of cells) {
    const page = rustDocsPagePath(cell.pagePath, paths);
    if (!pages.has(page)) pages.set(page, []);
    pages.get(page).push(cell);
  }
  const groups = new Map();
  for (const [page, members] of [...pages].sort(([a], [b]) => compareText(a, b))) {
    const { mode, key } = rustPageKey(page, grouping);
    const id = groupId(mode, key);
    const group = groups.get(id);
    if (group && group.key !== key)
      throw new Error(
        `Rust group keys ${JSON.stringify(group.key)} and ${JSON.stringify(key)} map to the same module id ${id}; adjust rust.grouping.`
      );
    if (group) {
      group.pages.push(page);
      group.cells.push(...members);
    } else groups.set(id, { id, mode, key, pages: [page], cells: [...members] });
  }
  const rustCellsDir = pathFromUrl(paths.rustCellsDir);
  return [...groups.values()]
    .sort((a, b) => compareText(a.id, b.id))
    .map((group) =>
      Object.freeze({
        ...group,
        ...rustGroupPackage(group.id),
        pages: Object.freeze(group.pages.sort(compareText)),
        cells: Object.freeze(group.cells.sort((a, b) => compareText(a.id, b.id))),
        sourceDir: path.join(rustCellsDir, 'modules', group.id)
      })
    );
}

export function describeRustGroup(group, limit = 3) {
  const pages = group.pages ?? [];
  const shown = pages.slice(0, limit).join(', ');
  return `${group.id} (${pages.length > limit ? `${shown}, and ${pages.length - limit} more` : shown})`;
}

// Locale-independent ordering keeps generated output identical across hosts.
export function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function describe(value) {
  if (typeof value === 'string')
    return value.length === 0
      ? 'an empty string'
      : value.isWellFormed()
        ? `a string of ${Array.from(value).length} characters`
        : 'a string with unpaired surrogates';
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a value of type ${typeof value}`;
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
