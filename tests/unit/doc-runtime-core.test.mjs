import { describe, expect, it } from 'vitest';
import {
  pageIdFromPath,
  relativePagePath,
  scopedCellId
} from '../../src/lib/doc-runtime/authoring-ids.mjs';
import {
  assertUniqueCellIds,
  assertUniqueRustInputBindings,
  extractCellsFromMarkdown,
  generateCellsJson,
  generateCellsModule,
  generateRustCargoToml,
  generateRustDependency,
  generateRustFunction,
  generateRustInputBinding,
  generateRustLib,
  generateRustReaders,
  helperCratesFromManifests,
  normalizeCrates,
  normalizeInputType,
  normalizeInputValue,
  normalizeInputs,
  normalizeOptionalNumber,
  normalizeOptions,
  normalizePackages,
  normalizeRunMode,
  normalizeStringArray,
  normalizeTimeout,
  parseCell,
  parseLanguage,
  packageNameFromCargoToml,
  rustFunctionName,
  rustIdentifier,
  rustReaderName,
  splitCellSource
} from '../../scripts/doc-runtime-core.mjs';

const highlighter = {
  codeToHtml: (source, options) => Promise.resolve(`<pre data-lang="${options.lang}">${source}</pre>`)
};

const helperCrates = new Map([
  ['doc-rust', { name: 'doc-rust', relativePath: '../../../crates/doc-rust' }],
  ['doc-rust-text', { name: 'doc-rust-text', relativePath: '../../../crates/doc-rust-text' }]
]);

describe('doc runtime core', () => {
  it('creates stable page-scoped authoring ids', () => {
    expect(pageIdFromPath('src/content/docs/ja/notes/example.mdx')).toBe('ja__notes__example');
    expect(relativePagePath('/repo', '/repo/src/content/docs/page.mdx')).toBe('src/content/docs/page.mdx');
    expect(relativePagePath('', '/repo/src/content/docs/page.mdx')).toBeUndefined();
    expect(scopedCellId('src/content/docs/page.mdx', 'cell id')).toBe('page__cell-id');
    expect(scopedCellId('', '---')).toBe('cell');
  });

  it('parses supported language aliases and ignores unknown languages', () => {
    expect(parseLanguage('rust')).toBe('rust');
    expect(parseLanguage('{rs} title')).toBe('rust');
    expect(parseLanguage('.py')).toBe('python');
    expect(parseLanguage('mermaid')).toBeUndefined();
  });

  it('splits metadata lines from executable source lines', () => {
    expect(splitCellSource('//| id: sample\nprintln!("ok");')).toEqual({
      metadataLines: ['id: sample'],
      sourceLines: ['println!("ok");']
    });
    expect(splitCellSource('///| id: doc\n#| title: py\nprint("ok")')).toEqual({
      metadataLines: ['id: doc', 'title: py'],
      sourceLines: ['print("ok")']
    });
  });

  it('parses cells and extracts cells from markdown fences', async () => {
    const cell = await parseCell(
      [
        '//| id: rust-cell',
        '//| title: Rust cell',
        '//| run: reactive',
        '//| crates: [doc-rust, doc-rust]',
        '//| timeoutMs: 42.8',
        '//| showSource: false',
        '//| inputs:',
        '//|   r: { type: range, label: r, min: 0, max: 4, step: 0.1, value: 3.2 }',
        'println!("{r}");'
      ].join('\n'),
      'rust',
      'page.mdx',
      { helperCrates, highlighter }
    );

    expect(cell).toMatchObject({
      id: 'page__rust-cell',
      language: 'rust',
      title: 'Rust cell',
      run: 'reactive',
      crates: ['doc-rust'],
      packages: [],
      timeoutMs: 42,
      showSource: false,
      pagePath: 'page.mdx'
    });
    expect(cell.inputs).toHaveLength(1);
    expect(cell.sourceHtml).toContain('data-lang="rust"');

    await expect(
      extractCellsFromMarkdown(
        [
          '```rust',
          '//| id: one',
          '//| crates: []',
          'println!("one");',
          '```',
          '```txt',
          'ignored',
          '```',
          '~~~python',
          '#| id: two',
          'print("two")',
          '~~~',
          '```rust',
          'println!("no metadata");',
          '```'
        ].join('\n'),
        'page.mdx',
        { helperCrates, highlighter }
      )
    ).resolves.toHaveLength(2);
  });

  it('returns no cell without metadata and rejects invalid cell metadata', async () => {
    await expect(parseCell('println!("ok");', 'rust', 'page.mdx', { helperCrates, highlighter })).resolves.toBeUndefined();
    await expect(parseCell('//|\nprintln!("ok");', 'rust', 'page.mdx', { helperCrates, highlighter })).rejects.toThrow(
      'missing an id option'
    );
    await expect(parseCell('//| title: missing\nprintln!("ok");', 'rust', 'page.mdx', { helperCrates, highlighter })).rejects.toThrow(
      'missing an id option'
    );
    await expect(parseCell('//| id: empty', 'rust', 'page.mdx', { helperCrates, highlighter })).rejects.toThrow(
      'does not contain code'
    );
    await expect(parseCell('//| id: bad\n//| run: sometimes\nprintln!("ok");', 'rust', 'page.mdx', {
      helperCrates,
      highlighter
    })).rejects.toThrow('Allowed values: button, reactive, autorun, hidden');
    await expect(parseCell('//| id: bad\n//| timeoutMs: 0\nprintln!("ok");', 'rust', 'page.mdx', {
      helperCrates,
      highlighter
    })).rejects.toThrow('invalid timeoutMs value 0');
    await expect(parseCell('//| id: bad\n//| inputs:\n//|   mode: { type: knob }\nprintln!("ok");', 'rust', 'page.mdx', {
      helperCrates,
      highlighter
    })).rejects.toThrow('for input "mode". Allowed values');
  });

  it('normalizes run modes, timeouts, package lists, and crate lists', () => {
    expect(normalizeRunMode(undefined)).toBe('button');
    expect(normalizeRunMode('button')).toBe('button');
    expect(normalizeRunMode('autorun')).toBe('autorun');
    expect(normalizeRunMode('hidden')).toBe('hidden');
    expect(normalizeRunMode('reactive')).toBe('reactive');
    expect(() => normalizeRunMode('unknown', 'cell', 'page')).toThrow(
      'Allowed values: button, reactive, autorun, hidden'
    );

    expect(normalizeTimeout(undefined)).toBe(30_000);
    expect(normalizeTimeout(10.8)).toBe(10);
    expect(() => normalizeTimeout(0, 'cell', 'page')).toThrow('Expected a positive number');
    expect(() => normalizeTimeout(Number.NaN, 'cell', 'page')).toThrow('Expected a positive number');
    expect(() => normalizeTimeout('bad', 'cell', 'page')).toThrow('Expected a positive number');

    expect(normalizePackages(null, 'python', 'cell', 'page')).toEqual([]);
    expect(normalizePackages([], 'python', 'cell', 'page')).toEqual([]);
    expect(normalizePackages(['numpy', 'numpy', 'pandas'], 'python', 'cell', 'page')).toEqual(['numpy', 'pandas']);
    expect(() => normalizePackages(['scipy'], 'python', 'cell', 'page')).toThrow('unsupported packages: scipy');
    expect(() => normalizePackages(['numpy'], 'rust', 'cell', 'page')).toThrow('must use crates');

    expect(normalizeCrates(null, 'rust', 'cell', 'page', helperCrates)).toEqual([]);
    expect(normalizeCrates(['doc-rust-text', 'doc-rust'], 'rust', 'cell', 'page', helperCrates)).toEqual([
      'doc-rust',
      'doc-rust-text'
    ]);
    expect(() => normalizeCrates(['missing'], 'rust', 'cell', 'page', helperCrates)).toThrow('helper crate');
    expect(() => normalizeCrates(['missing'], 'rust', 'cell', 'page', new Map())).toThrow('(none)');
    expect(() => normalizeCrates(['doc-rust'], 'python', 'cell', 'page', helperCrates)).toThrow('cannot specify crates');
  });

  it('validates string arrays and normalizes input specifications', () => {
    expect(normalizeStringArray([' b ', 'a', 'a'], 'field', 'cell', 'page')).toEqual(['a', 'b']);
    expect(() => normalizeStringArray('bad', 'field', 'cell', 'page')).toThrow('expected an array');
    expect(() => normalizeStringArray([''], 'field', 'cell', 'page')).toThrow('non-empty strings');

    expect(normalizeInputType('range')).toBe('range');
    expect(normalizeInputType('number')).toBe('number');
    expect(normalizeInputType('integer')).toBe('integer');
    expect(normalizeInputType('text')).toBe('text');
    expect(normalizeInputType('textarea')).toBe('textarea');
    expect(normalizeInputType('checkbox')).toBe('checkbox');
    expect(normalizeInputType('select')).toBe('select');
    expect(normalizeInputType('radio')).toBe('radio');
    expect(normalizeInputType(undefined)).toBe('text');
    expect(() => normalizeInputType('unknown', 'mode', 'cell', 'page')).toThrow('for input "mode"');

    expect(normalizeInputValue('checkbox', 1)).toBe(true);
    expect(normalizeInputValue('range', 2)).toBe(2);
    expect(normalizeInputValue('range', 'bad')).toBe(0);
    expect(normalizeInputValue('number', 2)).toBe(2);
    expect(normalizeInputValue('integer', 2.9)).toBe(2);
    expect(normalizeInputValue('integer', 'bad')).toBe(0);
    expect(normalizeInputValue('text', null)).toBe('');
    expect(normalizeInputValue('text', 12)).toBe('12');

    expect(normalizeOptionalNumber(3)).toBe(3);
    expect(normalizeOptionalNumber(Number.NaN)).toBeUndefined();
    expect(normalizeOptionalNumber('3')).toBeUndefined();

    expect(normalizeOptions(null)).toEqual([]);
    expect(normalizeOptions(['a', { label: 'Bee', value: 'b' }, { label: 'Only label' }, { value: 'only-value' }])).toEqual([
      { label: 'a', value: 'a' },
      { label: 'Bee', value: 'b' },
      { label: 'Only label', value: 'Only label' },
      { label: 'only-value', value: 'only-value' }
    ]);

    expect(normalizeInputs(null)).toEqual([]);
    expect(normalizeInputs([])).toEqual([]);
    expect(
      normalizeInputs({
        plain: 'hello',
        count: { type: 'integer', value: 2.7, min: 1, max: 9, step: 1, integer: false },
        choice: { type: 'select', value: 'a', options: ['a'] }
      })
    ).toEqual([
      {
        name: 'plain',
        type: 'text',
        label: 'plain',
        value: 'hello',
        min: undefined,
        max: undefined,
        step: undefined,
        integer: false,
        options: []
      },
      {
        name: 'count',
        type: 'integer',
        label: 'count',
        value: 2,
        min: 1,
        max: 9,
        step: 1,
        integer: true,
        options: []
      },
      {
        name: 'choice',
        type: 'select',
        label: 'choice',
        value: 'a',
        min: undefined,
        max: undefined,
        step: undefined,
        integer: false,
        options: [{ label: 'a', value: 'a' }]
      }
    ]);
  });

  it('validates uniqueness and derives helper crates from manifests', () => {
    expect(() => assertUniqueCellIds([{ id: 'one__a', pagePath: 'one' }, { id: 'two__a', pagePath: 'two' }])).not.toThrow();
    expect(() => assertUniqueCellIds([{ id: 'page__a', pagePath: 'page' }, { id: 'page__a', pagePath: 'page' }])).toThrow(
      'Duplicate interactive cell id'
    );

    expect(() =>
      assertUniqueRustInputBindings([
        { id: 'ok', pagePath: 'page', inputs: [{ name: 'value-a' }, { name: 'value_b' }] }
      ])
    ).not.toThrow();
    expect(() =>
      assertUniqueRustInputBindings([
        { id: 'bad', pagePath: 'page', inputs: [{ name: 'value-a' }, { name: 'value_a' }] }
      ])
    ).toThrow('both map to Rust binding');
    expect(() =>
      assertUniqueRustInputBindings([
        { id: 'keyword', pagePath: 'page', inputs: [{ name: 'type' }, { name: 'cell-type' }] }
      ])
    ).toThrow('both map to Rust binding "cell_type"');

    const crates = helperCratesFromManifests([
      { content: '[package]\nname = "b-crate"\n', manifestPath: '/repo/crates/b/Cargo.toml' },
      { content: '[package]\nname = "a-crate"\n', manifestPath: '/repo/crates/a/Cargo.toml' }
    ], { rustCrateDir: '/repo/src/generated/doc-runtime/rust-cells' });

    expect(Array.from(crates.keys())).toEqual(['a-crate', 'b-crate']);
    expect(crates.get('a-crate')).toEqual({ name: 'a-crate', relativePath: '../../../../crates/a' });
    expect(helperCratesFromManifests([], { rustCrateDir: '/repo/src/generated/doc-runtime/rust-cells' })).toEqual(
      new Map()
    );
    expect(packageNameFromCargoToml('[package]\nname = "doc-rust"\n', '/repo/crates/doc-rust/Cargo.toml')).toBe(
      'doc-rust'
    );
    expect(() => packageNameFromCargoToml('[dependencies]\nserde = "1"\n', '/repo/crates/bad/Cargo.toml')).toThrow(
      'missing [package] name'
    );
    expect(() =>
      helperCratesFromManifests([
        { content: '[package]\nname = "same"\n', manifestPath: '/repo/crates/a/Cargo.toml' },
        { content: '[package]\nname = "same"\n', manifestPath: '/repo/crates/b/Cargo.toml' }
      ], { rustCrateDir: '/repo/src/generated/doc-runtime/rust-cells' })
    ).toThrow('Duplicate helper crate');
  });

  it('generates manifest files and Rust support code', () => {
    const cells = [{ id: 'one', pagePath: 'page', language: 'rust', inputs: [] }];
    expect(generateCellsModule(cells)).toContain('export const cells');
    expect(generateCellsJson(cells)).toContain('"id": "one"');

    expect(generateRustCargoToml([], helperCrates)).not.toContain('doc-rust =');
    expect(generateRustCargoToml([], helperCrates)).toContain('license = "AGPL-3.0-only"');
    expect(generateRustCargoToml([{ crates: ['doc-rust'] }], helperCrates)).toContain(
      'doc-rust = { path = "../../../crates/doc-rust" }'
    );
    expect(generateRustDependency('doc-rust', helperCrates)).toContain('doc-rust');
    expect(() => generateRustDependency('missing', helperCrates)).toThrow('unknown Rust crate');

    expect(rustIdentifier('1-bad id')).toBe('cell_1_bad_id');
    expect(rustIdentifier('type')).toBe('cell_type');
    expect(rustIdentifier('match')).toBe('cell_match');
    expect(rustIdentifier('crate')).toBe('cell_crate');
    expect(rustFunctionName('cell-id')).toBe('run_cell_id');
    expect(rustFunctionName('page__cell')).toBe('run_page_cell');
    expect(rustReaderName({ type: 'checkbox' })).toBe('read_bool');
    expect(rustReaderName({ type: 'integer' })).toBe('read_u32');
    expect(rustReaderName({ type: 'text', integer: true })).toBe('read_u32');
    expect(rustReaderName({ type: 'range' })).toBe('read_f64');
    expect(rustReaderName({ type: 'number' })).toBe('read_f64');
    expect(rustReaderName({ type: 'text' })).toBe('read_string');

    expect(generateRustInputBinding({ name: 'value-name', type: 'number' })).toBe(
      'let value_name = read_f64(inputs, "value-name")?;'
    );
    expect(generateRustInputBinding({ name: 'type', type: 'text' })).toBe(
      'let cell_type = read_string(inputs, "type")?;'
    );

    const rustCell = {
      id: 'plot-cell',
      source: 'println!("ok");\nemit_line_plot!(&points, "n", "x");',
      inputs: [
        { name: 'r', type: 'range' },
        { name: 'steps', type: 'integer' },
        { name: 'enabled', type: 'checkbox' },
        { name: 'label', type: 'text' }
      ]
    };
    const preludeCell = {
      id: 'prelude-cell',
      source: [
        'emit_text!("hello");',
        'emit_json!(&serde_json::json!({"ok": true}));',
        'emit_html!("<strong>hello</strong>");',
        'emit_image_svg!("<svg />");',
        'emit_image_png!("abc");'
      ].join('\n'),
      inputs: []
    };
    expect(generateRustReaders([rustCell])).toContain('fn read_f64');
    expect(generateRustFunction(rustCell)).toContain('macro_rules! println');
    expect(generateRustFunction(rustCell)).toContain('macro_rules! emit_line_plot');
    expect(generateRustFunction(rustCell)).not.toContain('macro_rules! emit_json');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_json');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_image_svg');
    expect(generateRustFunction(rustCell)).toContain('Ok(finish_cell_output');
    expect(generateRustFunction({ id: 'plain', source: 'let value = 1;', inputs: [] })).toContain(
      'let __stdout = std::cell::RefCell::new(String::new());'
    );
    expect(generateRustLib([])).toContain('let _: Value = serde_json::from_str(inputs_json)');
    expect(generateRustLib([])).toContain('unknown Rust cell');
    expect(generateRustLib([rustCell])).toContain('enum OutputArtifact');
    expect(generateRustLib([rustCell])).toContain('outputs: Vec<OutputArtifact>');
    expect(generateRustLib([preludeCell])).toContain('Json(JsonArtifact)');
    expect(generateRustLib([preludeCell])).toContain('Html(HtmlArtifact)');
    expect(generateRustLib([preludeCell])).toContain('Image(ImageArtifact)');
    expect(generateRustLib([rustCell])).toContain('first_generated_cell_runs');
  });
});
