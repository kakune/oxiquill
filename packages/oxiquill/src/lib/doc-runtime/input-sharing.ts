import { initialValues } from './interactive-cell-model.js';
import { isNumericInput, validateNumericInputValue } from './interactive-input-validation.js';
import type { CellManifest, InputSpec, InputValues } from './types.js';

export const sharedInputsParameter = 'oxiquill-inputs';
export const maximumSharedUrlLength = 8192;
type SharedCell = Pick<CellManifest, 'id' | 'pagePath' | 'inputs'>;
type InputSnapshot = { values: InputValues; valid: boolean };
const snapshots = new WeakMap<Element, () => InputSnapshot>();

export function registerSharedInputs(element: Element, snapshot: () => InputSnapshot): () => void {
  snapshots.set(element, snapshot);
  return () => snapshots.delete(element);
}

export function sharedInputMetadata(cell: SharedCell): string | undefined {
  const inputs = cell.inputs.filter((input) => input.share === true);
  return inputs.length ? JSON.stringify({ id: cell.id, pagePath: cell.pagePath, inputs }) : undefined;
}

export function restoreSharedInputs(cell: SharedCell, href = globalThis.location?.href): InputValues {
  return { ...initialValues(cell.inputs), ...validatedSharedValues(cell, parseSharedInputs(href)[cell.id]) };
}

export function parseSharedInputs(href?: string): Record<string, unknown> {
  if (!href || href.length > maximumSharedUrlLength) return {};
  try {
    const encoded = new URL(href).searchParams.getAll(sharedInputsParameter);
    if (encoded.length !== 1) return {};
    const payload: unknown = JSON.parse(encoded[0]);
    return isRecord(payload) && payload.v === 1 && isRecord(payload.cells) ? payload.cells : {};
  } catch {
    return {};
  }
}

export function validatedSharedValues(cell: SharedCell, raw: unknown): InputValues {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    cell.inputs.flatMap((input) => {
      const value = Object.hasOwn(raw, input.name) ? raw[input.name] : undefined;
      return input.share === true && validSharedValue(input, value) ? [[input.name, value]] : [];
    })
  );
}

export function createInputShareUrl(
  pagePath: string,
  href = globalThis.location.href,
  documentObject = globalThis.document
): string {
  const url = new URL(href);
  const saved = parseSharedInputs(href);
  const cells: Array<[string, InputValues]> = [];
  for (const element of documentObject.querySelectorAll<HTMLElement>('[data-share-inputs]')) {
    const cell = JSON.parse(element.dataset.shareInputs ?? '{}') as SharedCell;
    if (cell.pagePath !== pagePath || !Array.isArray(cell.inputs)) continue;
    const snapshot = snapshots.get(element)?.();
    if (snapshot && !snapshot.valid) throw new Error('Complete invalid inputs before copying a link.');
    const values = validatedSharedValues(cell, snapshot?.values ?? saved[cell.id]);
    const changed = Object.fromEntries(
      cell.inputs.flatMap((input) =>
        Object.hasOwn(values, input.name) && values[input.name] !== input.value
          ? [[input.name, values[input.name]]]
          : []
      )
    );
    if (Object.keys(changed).length) cells.push([cell.id, changed]);
  }
  url.searchParams.delete(sharedInputsParameter);
  if (cells.length)
    url.searchParams.set(sharedInputsParameter, JSON.stringify({ v: 1, cells: Object.fromEntries(cells) }));
  if (url.href.length > maximumSharedUrlLength) throw new Error('The input sharing link exceeds 8192 characters.');
  return url.href;
}

function validSharedValue(input: InputSpec, value: unknown): value is InputValues[string] {
  if (isNumericInput(input)) return validateNumericInputValue(input, value) === undefined;
  if (input.type === 'checkbox') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  return (input.type !== 'select' && input.type !== 'radio') || input.options.some((option) => option.value === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
