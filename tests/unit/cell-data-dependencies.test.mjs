import { describe, expect, it } from 'vitest';
import {
  parseInteractiveCellNode,
  InteractiveCellValidationError
} from '../../packages/oxiquill/src/lib/doc-runtime/cell-authoring.mjs';
import { resolveDataDependencies } from '../../packages/oxiquill/src/lib/doc-runtime/cell-data-dependencies.mjs';
import { normalizeCell } from '../../packages/oxiquill/src/lib/doc-runtime/normalized-cell.mjs';
import { generateRustFunction } from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/functions.mjs';

const parse = (metadata, language = 'rust', page = 'docs/data.mdx') =>
  parseInteractiveCellNode(
    {
      type: 'code',
      lang: language,
      position: { start: { line: 10, column: 1 } },
      value: `${metadata
        .split('\n')
        .map((line) => `${language === 'rust' ? '//|' : '#|'} ${line}`)
        .join('\n')}\nlet value = 1;`
    },
    page
  );
const cell = (metadata, page) => {
  const result = parse(metadata, 'rust', page);
  if (result.kind !== 'cell') throw new Error(JSON.stringify(result));
  return result.cell;
};

describe('cell data authoring', () => {
  it('normalizes bindings, preserves exports/cache, and resolves page-local ids', () => {
    const producer = cell('id: producer\nexports: [points, truth]\ncache: inputs');
    const consumer = cell('id: consumer\ndependsOn:\n  raw: producer\n  typed: { cell: producer, type: Dataset }');
    const [a, b] = resolveDataDependencies([producer, consumer]);
    expect(b.dependsOn).toEqual({ raw: { cell: a.id }, typed: { cell: a.id, type: 'Dataset' } });
    expect(a.producerFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(normalizeCell(a)).toMatchObject({
      exports: ['points', 'truth'],
      cache: 'inputs',
      producerFingerprint: a.producerFingerprint
    });
    expect(normalizeCell(b).dependsOn).toEqual(b.dependsOn);
    expect(generateRustFunction(b)).toContain('let typed: Dataset = serde::Deserialize::deserialize');
    expect(generateRustFunction(b)).toContain('let raw: &serde_json::Value');
  });
  it.each([
    ['exports: []', 'exports'],
    ['exports: invalid', 'exports'],
    ['exports: [Bad]', 'exports[0]'],
    ['exports: [ok, ok]', 'exports[1]'],
    ['dependsOn: []', 'dependsOn'],
    ['dependsOn: { x: [] }', 'dependsOn.x'],
    ['dependsOn: { x: { cell: a, type: 3 } }', 'dependsOn.x.type'],
    ['dependsOn: { x: { cell: a, unexpected: true } }', 'dependsOn.x.unexpected'],
    ['dependsOn: { x: { cell: a, type: " " } }', 'dependsOn.x.type'],
    ['dependsOn: { inputs: a }', 'dependsOn.inputs'],
    ['dependsOn: { type: a }', 'dependsOn.type'],
    ['dependsOn: { Bad: a }', 'dependsOn.Bad'],
    ['cache: invalid\nexports: [a]', 'cache'],
    ['cache: inputs', 'cache'],
    ['inputs:\n  x: { type: integer, value: 1 }\ndependsOn: { x: a }', 'dependsOn.x']
  ])('rejects %s with field and location', (metadata, field) => {
    const result = parse(`id: invalid\n${metadata}`);
    expect(result.kind).toBe('invalid');
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pagePath: 'docs/data.mdx', fieldPath: field, line: expect.any(Number) })
      ])
    );
  });
  it('rejects duplicate YAML bindings', () => {
    expect(parse('id: invalid\ndependsOn:\n  raw: a\n  raw: b').kind).toBe('invalid');
  });
  it.each(['exports: [value]', 'dependsOn: { data: a }', 'cache: inputs'])(
    'rejects unsupported languages: %s',
    (metadata) => {
      expect(parse(`id: invalid\n${metadata}`, 'python').diagnostics[0].message).toContain(
        'not yet supported for python cells'
      );
    }
  );
  it('rejects missing, cross-page, nonproducer, unsupported, and cyclic dependencies', () => {
    const a = cell('id: a\nexports: [value]\ndependsOn: { data: b }');
    const b = cell('id: b\nexports: [value]\ndependsOn: { data: a }');
    expect(() => resolveDataDependencies([a, b])).toThrow('a -> b -> a');
    expect(() => resolveDataDependencies([a])).toThrow('dependsOn.data');
    expect(() => resolveDataDependencies([a, { ...b, pagePath: 'elsewhere.mdx' }])).toThrow('page-local');
    expect(() => resolveDataDependencies([a, { ...b, exports: undefined }])).toThrow('declares no exports');
    expect(() => resolveDataDependencies([a, { ...b, language: 'python' }])).toThrow('not yet supported for python');
    expect(() => resolveDataDependencies([a, b])).toThrow(InteractiveCellValidationError);
  });
  it('fingerprints source and used definitions, excluding authored display locations', () => {
    const a = cell('id: a\nexports: [value]');
    const fingerprint = (value) => resolveDataDependencies([value])[0].producerFingerprint;
    expect(fingerprint({ ...a, title: 'Renamed', sourcePosition: [] })).toBe(fingerprint(a));
    expect(fingerprint({ ...a, source: 'different source' })).not.toBe(fingerprint(a));
    expect(fingerprint({ ...a, definitions: [{ id: 'model', source: 'pub fn model() {}' }] })).not.toBe(fingerprint(a));
  });
});
