import path from 'node:path';
import { referencePageIdentity } from '../../lib/doc-runtime/references.mjs';
import { pathFromUrl } from '../../config/paths.mjs';
import { normalizeCell } from '../../lib/doc-runtime/normalized-cell.mjs';
import { collectAuthoringContent } from './cell-collection.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { listAuthoredHelperInputFiles } from './helper-inputs.mjs';
import { hashBytes, hashText, stableFingerprint } from './hashing.mjs';
import { normalizePath } from './path-utils.mjs';

export function createGenerationSnapshot(cells, helpers, pages = []) {
  // Clone before freezing so callers retain ownership of their parsed cells.
  const snapshot = structuredClone({
    cells: cells.map(normalizeCell).sort((a, b) => compare(a.id, b.id)),
    helpers: [...helpers].sort((a, b) => compare(a.path, b.path))
  });
  const sortedPages = [...pages].sort((a, b) => compare(a.pagePath, b.pagePath));
  const references = sortedPages.filter(
    (page) => page.references.length || page.cellReferences.length || page.links.length
  );
  return freezeDeep({
    ...snapshot,
    pages: structuredClone(sortedPages),
    referenceId: hashText(stableFingerprint(references.map(referencePageIdentity))),
    generationId: hashText(stableFingerprint(snapshot))
  });
}

export async function readHelperInputs({ fileSystem = defaultFileSystem, paths }) {
  const files = await listAuthoredHelperInputFiles(paths.cratesDir, { fileSystem });
  return Promise.all(
    files.map(async ({ filePath }) => ({
      path: normalizePath(path.relative(pathFromUrl(paths.workspaceRoot), filePath)),
      digest: hashBytes(await fileSystem.readFile(filePath))
    }))
  );
}

export async function readGenerationSnapshot(options) {
  const [content, helpers] = await Promise.all([collectAuthoringContent(options), readHelperInputs(options)]);
  return createGenerationSnapshot(content.cells, helpers, content.pages);
}

export function diffCells(expected, actual) {
  const before = new Map(expected.map((cell) => [cell.id, normalizeCell(cell)]));
  const after = new Map(actual.map((cell) => [cell.id, normalizeCell(cell)]));
  return [...new Set([...before.keys(), ...after.keys()])].flatMap((id) => {
    const previous = before.get(id);
    const next = after.get(id);
    const cell = next ?? previous;
    const fields =
      previous && next
        ? Object.keys({ ...previous, ...next }).filter(
            (field) => stableFingerprint(previous[field]) !== stableFingerprint(next[field])
          )
        : [];
    if (previous && next && fields.length === 0) return [];
    return [
      {
        kind: !previous ? 'added' : !next ? 'removed' : 'changed',
        path: cell.pagePath,
        cellId: id.split('__').at(-1),
        fields
      }
    ];
  });
}

export function diffGenerationSnapshots(expected, actual) {
  const before = new Map(expected.helpers.map((input) => [input.path, input.digest]));
  const after = new Map(actual.helpers.map((input) => [input.path, input.digest]));
  const helpers = [...new Set([...before.keys(), ...after.keys()])].flatMap((inputPath) =>
    before.get(inputPath) === after.get(inputPath)
      ? []
      : [
          {
            kind: !before.has(inputPath) ? 'added' : !after.has(inputPath) ? 'removed' : 'changed',
            path: inputPath
          }
        ]
  );
  const beforePages = new Map((expected.pages ?? []).map((page) => [page.pagePath, page]));
  const afterPages = new Map((actual.pages ?? []).map((page) => [page.pagePath, page]));
  const references =
    expected.referenceId === actual.referenceId
      ? []
      : [...new Set([...beforePages.keys(), ...afterPages.keys()])].flatMap((pagePath) => {
          const before = beforePages.get(pagePath);
          const after = afterPages.get(pagePath);
          if (
            stableFingerprint(before && referencePageIdentity(before)) ===
            stableFingerprint(after && referencePageIdentity(after))
          )
            return [];
          return [{ kind: !before ? 'added' : !after ? 'removed' : 'changed', path: pagePath }];
        });
  return [...diffCells(expected.cells, actual.cells), ...helpers, ...references].sort(
    (a, b) => compare(a.path, b.path) || compare(a.cellId ?? '', b.cellId ?? '') || compare(a.kind, b.kind)
  );
}

export function sourceChangedError(changes, { cause } = {}) {
  const details = changes.map(
    ({ kind, path: inputPath, cellId, fields = [] }) =>
      `  ${`${kind}:`.padEnd(9)}${inputPath}${cellId ? ` (cell ${JSON.stringify(cellId)}${fields.length ? `: ${fields.join(', ')}` : ''})` : ''}`
  );
  return new Error(
    [
      'Interactive cell sources changed after runtime generation started.',
      ...details,
      'Rerun `oxiquill build` once the sources are settled.'
    ].join('\n'),
    { cause }
  );
}

export async function assertGenerationSnapshot(expected, options) {
  let actual;
  try {
    actual = await readGenerationSnapshot(options);
  } catch (cause) {
    // A deleted page or temporarily invalid cell is also a source change.
    throw sourceChangedError([{ kind: 'changed', path: cause.message }], { cause });
  }
  if (expected.generationId !== actual.generationId || expected.referenceId !== actual.referenceId) {
    throw sourceChangedError(diffGenerationSnapshots(expected, actual));
  }
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function freezeDeep(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}
