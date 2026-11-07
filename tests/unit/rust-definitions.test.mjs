// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseCellsFromMarkdown } from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import { resolveRustDefinitions } from '../../packages/oxiquill/src/lib/doc-runtime/rust-definitions.mjs';
import { generateRustLibMapped } from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/lib.mjs';
import { normalizeCell } from '../../packages/oxiquill/src/lib/doc-runtime/normalized-cell.mjs';
import { sourceFingerprints } from '../../packages/oxiquill/src/generator/doc-runtime/plan-reasons.mjs';
import { validateCellDependencies } from '../../packages/oxiquill/src/lib/doc-runtime/cell-authoring.mjs';

const fence = (id, metadata = '', source = 'pub(crate) struct Model;') =>
  `\`\`\`rust\n//| id: ${id}\n${metadata}${source}\n\`\`\`\n`;
const parse = (text, page = 'content/docs/demo.mdx') => parseCellsFromMarkdown(text, page);
const definition = (id, uses = [], source) =>
  fence(id, `//| kind: definitions\n//| uses: ${JSON.stringify(uses)}\n`, source);
const resolve = (text) => resolveRustDefinitions(parse(text).cells);

describe('page-local Rust definitions', () => {
  it('preserves ordered imports and shares a deduplicated transitive dependency closure', () => {
    const blocks = resolve(
      definition('model') +
        definition('helper', ['model'], 'pub(crate) fn model() -> Model { Model }') +
        fence('run', '//| uses: [helper, model]\n', 'let _ = model();')
    );
    expect(blocks[2].uses).toEqual(['helper', 'model']);
    expect(blocks[2].definitions.map((block) => block.localId)).toEqual(['model', 'helper']);
    const mapped = generateRustLibMapped([blocks[2]]);
    expect(mapped.text.match(/mod definitions_/gu)).toHaveLength(2);
    expect(mapped.text).toContain('#[allow(dead_code, reason = "definitions may be partially used")]');
    expect(mapped.text).toContain('pub(crate) fn model() -> Model { Model }');
    expect(mapped.regions.filter((region) => region.kind === 'authored').map((region) => region.cellId)).toContain(
      blocks[0].id
    );
    expect(normalizeCell(blocks[0])).not.toHaveProperty('inputs');
    expect(normalizeCell(blocks[2])).not.toHaveProperty('definitions');
    expect(normalizeCell(blocks[2])).not.toHaveProperty('sourcePosition');
  });

  it('unions helper dependencies transitively without attaching unused blocks', () => {
    const blocks = resolve(
      fence('unused', '//| kind: definitions\n//| crates: [unused]\n') +
        fence('model', '//| kind: definitions\n//| crates: [alpha]\n') +
        definition('helper', ['model']) +
        fence('run', '//| uses: [helper]\n//| crates: [beta]\n', 'let _ = Model;')
    );
    expect(blocks[3].crates).toEqual(['alpha', 'beta']);
    expect(blocks[3].definitions.map((block) => block.localId)).toEqual(['model', 'helper']);
    expect(validateCellDependencies(blocks[0], new Map())[0]).toMatchObject({
      fieldPath: 'crates[0]',
      pagePath: 'content/docs/demo.mdx'
    });
  });

  it.each([
    [definition('a', ['missing']), 'does not exist'],
    [definition('a', ['a']), 'Self reference'],
    [definition('a', ['b']) + definition('b', ['a']), 'a -> b -> a'],
    [fence('run') + definition('a', ['run']), 'not a definitions block']
  ])('rejects invalid references with the field location', (source, message) => {
    expect(() => resolve(source)).toThrow(message);
    expect(() => resolve(source)).toThrow(/content\/docs\/demo.mdx:\d+:\d+.*uses:/u);
  });

  it('rejects references to blocks on another page', () => {
    const cells = [
      ...parse(definition('model'), 'content/docs/other.mdx').cells,
      ...parse(fence('run', '//| uses: [model]\n')).cells
    ];
    expect(() => resolveRustDefinitions(cells)).toThrow('another page');
  });

  it.each([
    'inputs: {}',
    'run: button',
    'timeoutMs: 10',
    'editable: false',
    'setup: other',
    'cases: []',
    'tests: []',
    'ref: target',
    'packages: []'
  ])('rejects definitions field %s', (field) => {
    const result = parse(fence('model', `//| kind: definitions\n//| ${field}\n`));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ fieldPath: field.split(':')[0], line: 4 }));
  });

  it.each(['python', 'haskell'])('rejects definitions and uses on %s', (language) => {
    const prefix = language === 'python' ? '#' : '--';
    const result = parse(
      `\`\`\`${language}\n${prefix}| id: model\n${prefix}| kind: definitions\n${prefix}| uses: []\npure\n\`\`\``
    );
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes(`not yet supported for ${language}`))
    ).toBe(true);
  });

  it.each(['//| kind: executable\n', '//| uses: [Bad.id]\n', '//| uses: [a, a]\n', '//| uses: a\n'])(
    'rejects invalid kind or uses %j',
    (metadata) => {
      expect(parse(fence('run', metadata)).diagnostics.length).toBeGreaterThan(0);
    }
  );

  it('fingerprints reachable block edits but excludes authored locations and unused blocks', () => {
    const original = definition('model') + definition('unused') + fence('run', '//| uses: [model]\n', 'let _ = Model;');
    const fingerprints = (text) => sourceFingerprints(resolve(text).filter((block) => block.kind !== 'definitions'));
    expect(fingerprints(`\n${original}`)).toEqual(fingerprints(original));
    expect(fingerprints(original.replace('id: unused', 'id: unreferenced'))).toEqual(fingerprints(original));
    expect(
      fingerprints(original.replace('pub(crate) struct Model;', 'pub(crate) struct Model { a: i32 }'))
    ).not.toEqual(fingerprints(original));
  });

  it.each(['\n', '\r\n'])('preserves leading whitespace and original source coordinates for %j', (newline) => {
    const text = [
      '---',
      'title: Test',
      '---',
      '',
      '  ```rust',
      '  //| id: example',
      '  //| crates: []',
      '  ',
      '    let label = "日本語";',
      '    label.missing();',
      '  ```'
    ].join(newline);
    const { cells, diagnostics } = parse(text);
    expect(diagnostics).toEqual([]);
    expect(cells[0].source).toBe(`${newline}  let label = "日本語";${newline}  label.missing();`);
    expect(cells[0].sourcePosition[2]).toMatchObject({ line: 10, column: 3, text: '    label.missing();' });
  });
});
