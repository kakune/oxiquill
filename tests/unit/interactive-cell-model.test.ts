import { describe, expect, it } from 'vitest';
import {
  coerceInputValue,
  formatInputValue,
  idleOutputMessage,
  initialValues,
  labelsForLanguage,
  localeFromLanguage,
  parseNumericInput,
  shouldShowInputControls,
  shouldShowRunButton
} from '../../packages/oxiquill/src/lib/doc-runtime/interactive-cell-model';
import type { InputSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const textInput: InputSpec = {
  name: 'label',
  type: 'text',
  label: 'label',
  value: 'sample',
  options: []
};

describe('interactive cell model', () => {
  it('builds initial values from input specs', () => {
    expect(
      initialValues([textInput, { name: 'enabled', type: 'checkbox', label: 'enabled', value: true, options: [] }])
    ).toEqual({ label: 'sample', enabled: true });
  });

  it('formats displayed input values', () => {
    expect(formatInputValue(2)).toBe('2');
    expect(formatInputValue(2.345)).toBe('2.35');
    expect(formatInputValue(true)).toBe('true');
    expect(formatInputValue('raw')).toBe('raw');
    expect(formatInputValue(1.2, 0.001)).toBe('1.200');
    expect(formatInputValue(0.0000003, 1e-7)).toBe('0.0000003');
    expect(formatInputValue(0.0075, 2.5e-3)).toBe('0.0075');
    expect(formatInputValue(0.30000000000000004, 0.1)).toBe('0.3');
  });

  it('describes run controls and idle output messages', () => {
    expect(shouldShowRunButton('button')).toBe(true);
    expect(shouldShowRunButton('autorun')).toBe(false);
    expect(shouldShowRunButton('reactive')).toBe(false);
    expect(shouldShowInputControls('button')).toBe(true);
    expect(shouldShowInputControls('reactive')).toBe(true);
    expect(shouldShowInputControls('autorun')).toBe(false);

    expect(idleOutputMessage('reactive')).toBe('Waiting for the runtime to start.');
    expect(idleOutputMessage('autorun')).toBe('Waiting for the runtime to start.');
    expect(idleOutputMessage('button')).toBe('Run the cell to show its output.');
  });

  it('resolves localized runtime labels', () => {
    expect(localeFromLanguage('en-US')).toBe('en');
    expect(localeFromLanguage('ja-JP')).toBe('ja');
    expect(localeFromLanguage(' JA-jpan-JP ')).toBe('ja');
    expect(localeFromLanguage('javanese')).toBe('en');
    expect(localeFromLanguage('fr-FR')).toBe('en');
    expect(localeFromLanguage('')).toBe('en');
    expect(localeFromLanguage()).toBe('en');
    expect(labelsForLanguage('ja').run).toBe('実行');
    expect(idleOutputMessage('reactive', labelsForLanguage('ja'))).toBe('ランタイムの起動を待っています。');
    expect(labelsForLanguage('ja').unknownCell('missing')).toBe('不明な実行可能セル: missing');
    expect(labelsForLanguage('fr').run).toBe('Run');
    expect(labelsForLanguage('fr')).toBe(labelsForLanguage('en'));
    expect(Object.values(labelsForLanguage('unknown')).every((label) => label !== undefined)).toBe(true);
    expect(labelsForLanguage('ja').diagnosticDetail('Artifact limit exceeded: received 17, maximum 16.')).toBe(
      '成果物の上限を超えました。17 件を受け取りましたが、上限は 16 件です。'
    );
    expect(labelsForLanguage('ja').diagnosticDetail('Sample cell timed out after 1000ms')).toBe(
      'Sample cell は 1000 ミリ秒でタイムアウトしました。'
    );
    expect(labelsForLanguage('ja').diagnosticDetail('Artifact data exceeds the remaining 16 MiB run limit.')).toBe(
      '実行あたり 16 MiB の残り上限を超えています。'
    );
    expect(labelsForLanguage('ja').diagnosticDetail('Chart data item limit exceeded: received 21, maximum 20.')).toBe(
      'グラフデータの上限を超えました。21 件を受け取りましたが、上限は 20 件です。'
    );
    expect(labelsForLanguage('ja').executionError('unknown failure')).toBe('セルの実行に失敗しました: unknown failure');
    expect(labelsForLanguage('ja').copyCsvError('unknown failure')).toBe(
      'CSV をコピーできませんでした: unknown failure'
    );
    expect(labelsForLanguage('ja').mermaidError('unknown failure')).toBe(
      'Mermaid 図を表示できませんでした: unknown failure'
    );
    expect(labelsForLanguage('en').runtimeLanguage('rust')).toBe('Rust + Wasm');
    expect(labelsForLanguage('en').runtimeLanguage('python')).toBe('Python + Pyodide');
    expect(labelsForLanguage('en').runtimeLanguage('haskell')).toBe('Haskell + WASI');
    const boundedDescription = labelsForLanguage('en').mermaidDescription(`  ${'diagram '.repeat(200)}  `);
    expect(boundedDescription).toHaveLength(1_014);
    expect(boundedDescription).toMatch(/…$/u);
  });

  it('coerces numeric input values and keeps text values', () => {
    expect(coerceInputValue({ ...textInput, type: 'number' }, '12')).toBe(12);
    expect(coerceInputValue({ ...textInput, type: 'integer' }, '12')).toBe(12);
    expect(coerceInputValue(textInput, '12')).toBe('12');
    expect(coerceInputValue({ ...textInput, type: 'number' }, '')).toBe('');
  });

  it('parses only complete finite numeric values that satisfy every constraint', () => {
    const numberInput: InputSpec = {
      ...textInput,
      type: 'number',
      value: 1,
      min: -2,
      max: 2,
      step: 0.5
    };

    expect(parseNumericInput(numberInput, '')).toEqual({ valid: false, validation: 'required' });
    expect(parseNumericInput(numberInput, '-')).toEqual({ valid: false, validation: 'number' });
    expect(parseNumericInput(numberInput, '1e309')).toEqual({ valid: false, validation: 'number' });
    expect(parseNumericInput(numberInput, '-2.5')).toEqual({ valid: false, validation: 'rangeUnderflow' });
    expect(parseNumericInput(numberInput, '2.5')).toEqual({ valid: false, validation: 'rangeOverflow' });
    expect(parseNumericInput(numberInput, '1.25')).toEqual({ valid: false, validation: 'stepMismatch' });
    expect(parseNumericInput(numberInput, '-1.5')).toEqual({ valid: true, value: -1.5 });
  });

  it('enforces the portable signed 32-bit integer domain', () => {
    const integerInput: InputSpec = { ...textInput, type: 'integer', value: 0 };

    expect(parseNumericInput(integerInput, '-2147483648')).toEqual({ valid: true, value: -2147483648 });
    expect(parseNumericInput(integerInput, '2147483647')).toEqual({ valid: true, value: 2147483647 });
    expect(parseNumericInput(integerInput, '-2147483649')).toEqual({ valid: false, validation: 'integer' });
    expect(parseNumericInput(integerInput, '2147483648')).toEqual({ valid: false, validation: 'integer' });
    expect(parseNumericInput(integerInput, '9007199254740992')).toEqual({ valid: false, validation: 'integer' });
  });
});
