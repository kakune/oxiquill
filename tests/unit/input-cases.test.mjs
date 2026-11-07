import { describe, expect, it } from 'vitest';
import {
  parseInteractiveCellNode,
  formatInteractiveCellDiagnostic
} from '../../packages/oxiquill/src/lib/doc-runtime/cell-authoring.mjs';
import { createCellManifest } from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import { generateCellsJson } from '../../packages/oxiquill/src/generator/doc-runtime-core.mjs';
import {
  createGenerationSnapshot,
  diffGenerationSnapshots
} from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';
import { summarizeCells } from '../../packages/oxiquill/src/generator/doc-runtime/runtime-summary.mjs';

const inputDefinitions = `inputs:
  count: { type: integer, value: 2, min: 0, max: 10, step: 2 }
  ratio: { type: range, value: 0.3, min: 0.1, max: 1, step: 0.1 }
  anchored: { type: number, value: 1, step: 2 }
  implicit: { type: number, value: 0.5 }
  integer: { type: number, integer: true, value: 1 }
  text: { type: text, value: original }
  notes: { type: textarea, value: notes }
  enabled: { type: checkbox, value: true }
  choice: { type: select, value: a, options: [a, b] }
  radio: { type: radio, value: a, options: [a, b] }`;
const defaults = {
  count: 2,
  ratio: 0.3,
  anchored: 1,
  implicit: 0.5,
  integer: 1,
  text: 'original',
  notes: 'notes',
  enabled: true,
  choice: 'a',
  radio: 'a'
};

function parse(metadata, language = 'python', inputs = inputDefinitions) {
  const prefix = { python: '#|', rust: '//|', haskell: '--|' }[language];
  return parseInteractiveCellNode(
    {
      type: 'code',
      lang: language,
      position: { start: { line: 42 } },
      value:
        [`id: example`, inputs, metadata]
          .filter(Boolean)
          .join('\n')
          .split('\n')
          .map((line) => `${prefix} ${line}`)
          .join('\n') + '\nprint(1)'
    },
    'content/docs/cases.mdx'
  );
}

describe('input case authoring', () => {
  it.each(['rust', 'python', 'haskell'])('normalizes partial overrides and empty maps for %s', async (language) => {
    const result = parse(
      `cases:
  - id: selected
    label: '  Selected  '
    description: '  Authored description  '
    inputs: { count: 8, ratio: 0.7, anchored: 3, implicit: 1.5, integer: 5, enabled: false, choice: b, radio: b, text: 日本語, notes: '' }
  - id: original
    label: Original
    inputs: {}`,
      language
    );
    expect(result).toMatchObject({
      kind: 'cell',
      cell: {
        cases: [
          {
            id: 'selected',
            label: 'Selected',
            description: 'Authored description',
            inputs: {
              ...defaults,
              count: 8,
              ratio: 0.7,
              anchored: 3,
              implicit: 1.5,
              integer: 5,
              enabled: false,
              choice: 'b',
              radio: 'b',
              text: '日本語',
              notes: ''
            }
          },
          { id: 'original', label: 'Original', inputs: defaults }
        ]
      }
    });
    const manifest = await createCellManifest(result.cell, { codeToHtml: async () => '<pre>source</pre>' });
    expect(JSON.parse(generateCellsJson([manifest]))[0].cases).toEqual(result.cell.cases);
  });

  it.each(['', 'cases: []'])('keeps cells without cases unchanged (%s)', (metadata) => {
    expect(parse(metadata).cell).not.toHaveProperty('cases');
  });

  it.each([
    ['cases: {}', 'cases'],
    ['cases: null', 'cases'],
    ['cases: selected', 'cases'],
    ['cases: [null]', 'cases[0]'],
    ['cases: [selected]', 'cases[0]'],
    ['cases: [[]]', 'cases[0]'],
    ['cases: [{ label: Test, inputs: {} }]', 'cases[0].id'],
    ['cases: [{ id: Bad_id, label: Test, inputs: {} }]', 'cases[0].id'],
    ['cases: [{ id: default, label: Test, inputs: {} }]', 'cases[0].id'],
    ['cases: [{ id: first, label: Test, inputs: {} }, { id: first, label: Again, inputs: {} }]', 'cases[1].id'],
    ['cases: [{ id: first, inputs: {} }]', 'cases[0].label'],
    ['cases: [{ id: first, label: "  ", inputs: {} }]', 'cases[0].label'],
    ['cases: [{ id: first, label: 1, inputs: {} }]', 'cases[0].label'],
    ['cases: [{ id: first, label: Test }]', 'cases[0].inputs'],
    ['cases: [{ id: first, label: Test, inputs: [] }]', 'cases[0].inputs'],
    ['cases: [{ id: first, label: Test, inputs: null }]', 'cases[0].inputs'],
    ['cases: [{ id: first, label: Test, inputs: { unknown: 1 } }]', 'cases[0].inputs.unknown'],
    ['cases: [{ id: first, label: Test, inputs: {}, extra: true }]', 'cases[0].extra'],
    ['cases: [{ id: first, label: Test, description: "", inputs: {} }]', 'cases[0].description'],
    ['cases: [{ id: first, label: Test, description: [], inputs: {} }]', 'cases[0].description'],
    ['run: autorun\ncases: []', 'cases']
  ])('reports full context for %s', (metadata, fieldPath) => {
    const result = parse(metadata);
    expect(result.kind).toBe('invalid');
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ pagePath: 'content/docs/cases.mdx', fenceStartLine: 42, cellId: 'example', fieldPath })
    );
    expect(
      formatInteractiveCellDiagnostic(result.diagnostics.find((entry) => entry.fieldPath === fieldPath))
    ).toContain(fieldPath);
  });

  it.each([
    ['count', '-2'],
    ['count', '12'],
    ['count', '3'],
    ['count', '2.5'],
    ['count', '2147483648'],
    ['count', '"4"'],
    ['ratio', '0.25'],
    ['anchored', '2'],
    ['implicit', '1'],
    ['integer', '1.5'],
    ['ratio', '.nan'],
    ['ratio', '.inf'],
    ['enabled', '1'],
    ['enabled', '"false"'],
    ['text', 'true'],
    ['notes', '{}'],
    ['choice', 'missing'],
    ['radio', 'missing'],
    ['text', 'null']
  ])('rejects %s=%s at the case value path', (name, value) => {
    const result = parse(`cases: [{ id: first, label: Test, inputs: { ${name}: ${value} } }]`);
    expect(result).toMatchObject({ kind: 'invalid' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ fieldPath: `cases[0].inputs.${name}` }));
  });

  it('bounds input and case labels after trimming', () => {
    for (const length of [256, 257]) {
      const label = 'x'.repeat(length);
      const result = parse(
        `cases: [{ id: first, label: ' ${label} ', inputs: {} }]`,
        'python',
        `inputs: { text: { label: ' ${label} ' } }`
      );
      if (length === 256) expect(result.kind).toBe('cell');
      else expect(result.diagnostics.map((entry) => entry.fieldPath)).toEqual(['inputs.text.label', 'cases[0].label']);
    }
  });

  it('changes the manifest fingerprint without invalidating compiled language fingerprints', () => {
    const cells = ['rust', 'python', 'haskell'].map(
      (language) => parse('cases: [{ id: first, label: Test, inputs: {} }]', language).cell
    );
    const current = summarizeCells(cells);
    const changed = summarizeCells(
      cells.map((cell) => ({
        ...cell,
        cases: [{ ...cell.cases[0], label: 'Renamed', inputs: { ...defaults, count: 8 } }]
      }))
    );
    expect(changed.manifestFingerprint).not.toBe(current.manifestFingerprint);
    expect(changed.rustFingerprint).toBe(current.rustFingerprint);
    expect(changed.haskellFingerprint).toBe(current.haskellFingerprint);
    expect(changed.pythonFingerprint).toBe(current.pythonFingerprint);
    const before = createGenerationSnapshot([cells[0]], []);
    const after = createGenerationSnapshot([{ ...cells[0], cases: [] }], []);
    expect(after.generationId).not.toBe(before.generationId);
    expect(diffGenerationSnapshots(before, after)).toEqual([
      { kind: 'changed', path: cells[0].pagePath, cellId: 'example', fields: ['cases'] }
    ]);
  });
});
