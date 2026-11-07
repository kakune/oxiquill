import { initialValues, matchingInputCase } from './interactive-cell-model.js';
import { validInputValue } from './input-value-validation.mjs';
import type { CellManifest, InputValues } from './types.js';

export const sharedInputsParameter = 'oxiquill-inputs';
export const maximumSharedUrlLength = 8192;
type SharedCell = Pick<CellManifest, 'id' | 'pagePath' | 'inputs' | 'cases'>;
type SharedCellInputs = { values: unknown; case?: unknown };
type InputSnapshot = { values: InputValues; valid: boolean };
const snapshots = new WeakMap<Element, () => InputSnapshot>();

export function registerSharedInputs(element: Element, snapshot: () => InputSnapshot): () => void {
  snapshots.set(element, snapshot);
  return () => snapshots.delete(element);
}

export function sharedInputMetadata(cell: SharedCell): string | undefined {
  const inputs = cell.cases?.length ? cell.inputs : cell.inputs.filter((input) => input.share === true);
  return inputs.length || cell.cases?.length
    ? JSON.stringify({
        id: cell.id,
        pagePath: cell.pagePath,
        inputs,
        ...(cell.cases?.length ? { cases: cell.cases } : {})
      })
    : undefined;
}

export function restoreSharedInputs(
  cell: SharedCell,
  href = globalThis.location?.href,
  currentValues?: InputValues
): InputValues {
  const saved = parseSharedInputs(href)[cell.id];
  const selectedCase = cell.cases?.find((candidate) => candidate.id === saved?.case);
  if (selectedCase) return { ...selectedCase.inputs };
  const defaults = initialValues(cell.inputs);
  const base = currentValues
    ? Object.fromEntries(
        cell.inputs.map((input) => [input.name, input.share ? input.value : (currentValues[input.name] ?? input.value)])
      )
    : defaults;
  return { ...base, ...validatedSharedValues(cell, saved?.values) };
}

// Normalize legacy links at the boundary so restoration and sharing use one shape.
export function parseSharedInputs(href?: string): Record<string, SharedCellInputs> {
  if (!href || href.length > maximumSharedUrlLength) return {};
  try {
    const encoded = new URL(href).searchParams.getAll(sharedInputsParameter);
    if (encoded.length !== 1) return {};
    const payload: unknown = JSON.parse(encoded[0]);
    if (!isRecord(payload) || (payload.v !== 1 && payload.v !== 2) || !isRecord(payload.cells)) return {};
    return Object.fromEntries(
      Object.entries(payload.cells).flatMap(([id, entry]) => {
        if (!isRecord(entry)) return [];
        return [[id, payload.v === 1 ? { values: entry } : { values: entry.values, case: entry.case }]];
      })
    );
  } catch {
    return {};
  }
}

export function validatedSharedValues(cell: SharedCell, raw: unknown): InputValues {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    cell.inputs.flatMap((input) => {
      const value = Object.hasOwn(raw, input.name) ? raw[input.name] : undefined;
      return input.share === true && validInputValue(input, value) ? [[input.name, value]] : [];
    })
  );
}

export function createInputShareUrl(
  pagePath: string,
  href = globalThis.location.href,
  documentObject = globalThis.document
): string {
  const url = new URL(href);
  const cells: Array<[string, { values: InputValues; case?: string }]> = [];
  for (const element of documentObject.querySelectorAll<HTMLElement>('[data-share-inputs]')) {
    const cell = JSON.parse(element.dataset.shareInputs ?? '{}') as SharedCell;
    if (cell.pagePath !== pagePath || !Array.isArray(cell.inputs)) continue;
    const snapshot = snapshots.get(element)?.();
    if (snapshot && !snapshot.valid) throw new Error('Complete invalid inputs before copying a link.');
    const current = snapshot?.values ?? restoreSharedInputs(cell, href);
    const values = validatedSharedValues(cell, current);
    const changed = Object.fromEntries(
      cell.inputs.flatMap((input) =>
        Object.hasOwn(values, input.name) && values[input.name] !== input.value
          ? [[input.name, values[input.name]]]
          : []
      )
    );
    const selectedCase = matchingInputCase(cell, current);
    if (Object.keys(changed).length || selectedCase)
      cells.push([cell.id, { values: changed, ...(selectedCase ? { case: selectedCase.id } : {}) }]);
  }
  url.searchParams.delete(sharedInputsParameter);
  if (cells.length)
    url.searchParams.set(sharedInputsParameter, JSON.stringify({ v: 2, cells: Object.fromEntries(cells) }));
  if (url.href.length > maximumSharedUrlLength) throw new Error('The input sharing link exceeds 8192 characters.');
  return url.href;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
