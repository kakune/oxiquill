import type { RuntimeLabels } from './runtime-localization.js';
import { labelsForLanguage } from './runtime-localization.js';
import type { CellManifest, InputSpec, InputValues, RunMode } from './types.js';
import { validInputValue } from './input-value-validation.mjs';

export {
  formatInputValue,
  parseNumericInput,
  stepNumericInputValue,
  validateNumericInputValue
} from './interactive-input-validation.js';

export { labelsForLanguage, localeFromLanguage } from './runtime-localization.js';
export type { RuntimeLabels, RuntimeLocale } from './runtime-localization.js';

export function initialValues(inputs: readonly InputSpec[]): InputValues {
  return Object.fromEntries(inputs.map((input) => [input.name, input.value]));
}

export function matchingInputCase(cell: Pick<CellManifest, 'inputs' | 'cases'>, values: InputValues) {
  return cell.cases?.find((candidate) =>
    cell.inputs.every((input) => values[input.name] === candidate.inputs[input.name])
  );
}

export function reconcileInputValues(inputs: readonly InputSpec[], values: InputValues): InputValues {
  return Object.fromEntries(
    inputs.map((input) => [input.name, validInputValue(input, values[input.name]) ? values[input.name] : input.value])
  );
}

export function cellExecutionTimeoutMs(cell: CellManifest): number {
  return (cell.language === 'python' ? (cell.setup ?? []) : []).reduce(
    (total, step) => total + step.timeoutMs,
    cell.timeoutMs
  );
}

export function shouldShowRunButton(runMode: RunMode): boolean {
  return runMode === 'button';
}

export function shouldShowInputControls(runMode: RunMode): boolean {
  return runMode !== 'autorun';
}

export function idleOutputMessage(
  runMode: CellManifest['run'],
  labels: RuntimeLabels = labelsForLanguage('en')
): string {
  return runMode === 'reactive' || runMode === 'autorun' ? labels.idleReactive : labels.idleButton;
}

export function coerceInputValue(input: InputSpec, rawValue: string): string | number {
  if (input.type === 'number' || input.type === 'integer') {
    const value = Number(rawValue);
    return rawValue.trim() !== '' && Number.isFinite(value) ? value : rawValue;
  }
  return rawValue;
}
