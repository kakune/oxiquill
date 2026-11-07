import { numericStepGrid } from './numeric-step.mjs';
import { isPortableInteger, PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MIN } from './portable-integer.mjs';

/** @typedef {import('./types.js').InputSpec} InputSpec */
/** @typedef {'required' | 'number' | 'integer' | 'rangeUnderflow' | 'rangeOverflow' | 'stepMismatch'} NumericInputValidation */

/** @param {InputSpec} input */
export function isIntegerInput(input) {
  return input.type === 'integer' || input.integer === true;
}

/** @param {InputSpec} input */
export function isNumericInput(input) {
  return input.type === 'range' || input.type === 'number' || input.type === 'integer';
}

/** @param {InputSpec} input */
export function effectiveMinimum(input) {
  return isIntegerInput(input) ? Math.max(input.min ?? PORTABLE_INTEGER_MIN, PORTABLE_INTEGER_MIN) : input.min;
}

/** @param {InputSpec} input */
export function effectiveMaximum(input) {
  return isIntegerInput(input) ? Math.min(input.max ?? PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MAX) : input.max;
}

/**
 * @param {InputSpec} input
 * @param {unknown} value
 * @returns {NumericInputValidation | undefined}
 */
export function validateNumericInputValue(input, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'number';
  if (isIntegerInput(input) && !isPortableInteger(value)) return 'integer';
  const minimum = effectiveMinimum(input);
  const maximum = effectiveMaximum(input);
  if (minimum !== undefined && value < minimum) return 'rangeUnderflow';
  if (maximum !== undefined && value > maximum) return 'rangeOverflow';
  if (numericStepGrid(input, value).stepMismatch) return 'stepMismatch';
  return undefined;
}

/**
 * @param {InputSpec} input
 * @param {unknown} value
 * @returns {value is import('./types.js').InputValues[string]}
 */
export function validInputValue(input, value) {
  if (isNumericInput(input)) return validateNumericInputValue(input, value) === undefined;
  if (input.type === 'checkbox') return typeof value === 'boolean';
  if (typeof value !== 'string') return false;
  return (input.type !== 'select' && input.type !== 'radio') || input.options.some((option) => option.value === value);
}
