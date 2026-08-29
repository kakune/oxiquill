import { describe, expect, it } from 'vitest';
import {
  coerceInputValue,
  formatInputValue,
  idleOutputMessage,
  initialValues,
  labelsForLanguage,
  localeFromLanguage,
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
    expect(labelsForLanguage('ja').run).toBe('実行');
    expect(idleOutputMessage('reactive', labelsForLanguage('ja'))).toBe('ランタイムの起動を待っています。');
    expect(labelsForLanguage('ja').unknownCell('missing')).toBe('不明な実行可能セル: missing');
  });

  it('coerces numeric input values and keeps text values', () => {
    expect(coerceInputValue({ ...textInput, type: 'number' }, '12')).toBe(12);
    expect(coerceInputValue({ ...textInput, type: 'integer' }, '12')).toBe(12);
    expect(coerceInputValue(textInput, '12')).toBe('12');
  });
});
