import type { CellManifest, InputSpec, InputValues } from './types.js';
import { isPortableInteger, PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MIN } from './portable-integer.mjs';

export type NumericInputValidation =
  'required' | 'number' | 'integer' | 'rangeUnderflow' | 'rangeOverflow' | 'stepMismatch';

export type ParsedNumericInput = { valid: false; validation: NumericInputValidation } | { valid: true; value: number };

export function parseNumericInput(input: InputSpec, rawValue: string): ParsedNumericInput {
  if (rawValue.trim() === '') return { valid: false, validation: 'required' };

  const value = Number(rawValue);
  const validation = validateNumericInputValue(input, value);
  return validation ? { valid: false, validation } : { valid: true, value };
}

export function validateNumericInputValue(input: InputSpec, value: unknown): NumericInputValidation | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'number';
  if (isIntegerInput(input) && !isPortableInteger(value)) return 'integer';

  const minimum = effectiveMinimum(input);
  const maximum = effectiveMaximum(input);
  if (minimum !== undefined && value < minimum) return 'rangeUnderflow';
  if (maximum !== undefined && value > maximum) return 'rangeOverflow';
  if (hasStepMismatch(input, value)) return 'stepMismatch';
  return undefined;
}

export function assertValidInputValues(cell: CellManifest, values: InputValues): void {
  for (const input of cell.inputs) {
    const value = values[input.name];
    if (isNumericInput(input)) {
      const validation = validateNumericInputValue(input, value);
      if (validation) {
        throw new Error(`input ${input.name} has an invalid committed numeric value (${validation})`);
      }
      continue;
    }

    if (input.type === 'checkbox' ? typeof value !== 'boolean' : typeof value !== 'string') {
      throw new Error(`input ${input.name} has an invalid committed value`);
    }
  }
}

export function completeInputValues(cell: CellManifest, values: InputValues): InputValues {
  return Object.fromEntries(cell.inputs.map((input) => [input.name, values[input.name] ?? input.value]));
}

export function formatInputValue(value: string | number | boolean, step?: number): string {
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value)) return String(value);
  if (step === undefined) return value.toFixed(Number.isInteger(value) ? 0 : 2);

  const precision = decimalPlaces(step);
  return precision === 0 ? value.toFixed(0) : value.toFixed(Math.min(precision, 100));
}

export function effectiveMinimum(input: InputSpec): number | undefined {
  return isIntegerInput(input) ? Math.max(input.min ?? PORTABLE_INTEGER_MIN, PORTABLE_INTEGER_MIN) : input.min;
}

export function effectiveMaximum(input: InputSpec): number | undefined {
  return isIntegerInput(input) ? Math.min(input.max ?? PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MAX) : input.max;
}

export function effectiveStep(input: InputSpec): number {
  return input.step ?? 1;
}

export function stepNumericInputValue(input: InputSpec, value: number, direction: -1 | 1): number {
  const precision = Math.min(
    Math.max(decimalPlaces(effectiveStep(input)), decimalPlaces(value), decimalPlaces(input.min ?? 0)),
    100
  );
  const stepped = Number((value + direction * effectiveStep(input)).toFixed(precision));
  return Math.min(effectiveMaximum(input) ?? stepped, Math.max(effectiveMinimum(input) ?? stepped, stepped));
}

export function isIntegerInput(input: InputSpec): boolean {
  return input.type === 'integer' || input.integer === true;
}

export function isNumericInput(input: InputSpec): boolean {
  return input.type === 'range' || input.type === 'number' || input.type === 'integer';
}

function hasStepMismatch(input: InputSpec, value: number): boolean {
  const step = effectiveStep(input);
  const base = input.min ?? (typeof input.value === 'number' ? input.value : 0);
  const steps = (value - base) / step;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8;
  return Math.abs(steps - Math.round(steps)) > tolerance;
}

function decimalPlaces(value: number): number {
  const text = String(value).toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const exponent = exponentText ? Number(exponentText) : 0;
  const fractionLength = coefficient.split('.')[1]?.length ?? 0;
  return Math.max(0, fractionLength - exponent);
}
