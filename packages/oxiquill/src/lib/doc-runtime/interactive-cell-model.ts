import type { CellManifest, InputSpec, InputValues, RunMode } from './types.js';

export type RuntimeLocale = 'en' | 'ja';

export type RuntimeLabels = {
  hideCode: string;
  idleButton: string;
  idleReactive: string;
  run: string;
  running: string;
  runningCell: string;
  showCode: string;
  unknownCell: (cellId: string) => string;
};

const runtimeLabels = {
  en: {
    hideCode: 'Hide code',
    idleButton: 'Run the cell to show its output.',
    idleReactive: 'Waiting for the runtime to start.',
    run: 'Run',
    running: 'Running',
    runningCell: 'Running cell...',
    showCode: 'Show code',
    unknownCell: (cellId: string) => `Unknown interactive cell: ${cellId}`
  },
  ja: {
    hideCode: 'コードを隠す',
    idleButton: 'セルを実行すると出力が表示されます。',
    idleReactive: 'ランタイムの起動を待っています。',
    run: '実行',
    running: '実行中',
    runningCell: 'セルを実行中...',
    showCode: 'コードを表示',
    unknownCell: (cellId: string) => `不明な実行可能セル: ${cellId}`
  }
} satisfies Record<RuntimeLocale, RuntimeLabels>;

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

export function labelsForLanguage(languageTag?: string): RuntimeLabels {
  return runtimeLabels[localeFromLanguage(languageTag)];
}

export function localeFromLanguage(languageTag?: string): RuntimeLocale {
  return languageTag?.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function idleOutputMessage(runMode: CellManifest['run'], labels: RuntimeLabels = runtimeLabels.en): string {
  return runMode === 'reactive' || runMode === 'autorun' ? labels.idleReactive : labels.idleButton;
}

export function coerceInputValue(input: InputSpec, rawValue: string): string | number {
  if (input.type === 'number' || input.type === 'integer') return Number(rawValue);
  return rawValue;
}
