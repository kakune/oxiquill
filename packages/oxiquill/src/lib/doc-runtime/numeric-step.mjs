/**
 * @typedef {{ min?: number, step?: number, value?: unknown }} NumericStepInput
 */

/**
 * @param {NumericStepInput} input
 * @returns {number}
 */
export function effectiveNumericStep(input) {
  return input.step ?? 1;
}

/**
 * @param {NumericStepInput} input
 * @param {number} value
 * @returns {{ base: number, effectiveStep: number, stepMismatch: boolean }}
 */
export function numericStepGrid(input, value) {
  const effectiveStep = effectiveNumericStep(input);
  const base = input.min ?? (typeof input.value === 'number' ? input.value : 0);
  const steps = (value - base) / effectiveStep;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(steps)) * 8;

  return {
    base,
    effectiveStep,
    stepMismatch: Math.abs(steps - Math.round(steps)) > tolerance
  };
}
