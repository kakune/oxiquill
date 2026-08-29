import type { RuntimeLabels } from './runtime-localization.js';
import { labelsForLanguage } from './runtime-localization.js';
import type { CellManifest, InputSpec, InputValues, RunMode } from './types.js';

export { labelsForLanguage, localeFromLanguage } from './runtime-localization.js';
export type { RuntimeLabels, RuntimeLocale } from './runtime-localization.js';

export function initialValues(inputs: readonly InputSpec[]): InputValues {
  return Object.fromEntries(inputs.map((input) => [input.name, input.value]));
}

export function formatInputValue(value: string | number | boolean): string {
  return typeof value === 'number' ? value.toFixed(Number.isInteger(value) ? 0 : 2) : String(value);
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
  if (input.type === 'number' || input.type === 'integer') return Number(rawValue);
  return rawValue;
}
