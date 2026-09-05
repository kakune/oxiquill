import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pageIdFromPath,
  relativePagePath,
  scopedCellId
} from '../../packages/oxiquill/src/lib/doc-runtime/authoring-ids.mjs';
import { scanRustMacroInvocations } from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/macro-invocations.mjs';
import {
  rustOutputCapabilities,
  rustSourceCapabilities
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/capabilities.mjs';
import { generateRustPreludeMacros } from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/macros.mjs';
import {
  assertUniqueCellIds,
  assertUniqueHaskellFunctionNames,
  assertUniqueHaskellInputBindings,
  assertUniqueRustFunctionNames,
  assertUniqueRustInputBindings,
  extractCellsFromMarkdown,
  generateCellsJson,
  generateCellsModule,
  generateHaskellFunction,
  generateHaskellInputBinding,
  generateHaskellMain,
  generateRustCargoToml,
  generateRustDependency,
  generateRustFunction,
  generateRustInputBinding,
  generateRustLib,
  generateRustReaders,
  helperCratesFromManifests,
  parseCellsFromMarkdown,
  parseLanguage,
  packageNameFromCargoToml,
  haskellFunctionName,
  haskellIdentifier,
  haskellReaderName,
  rustFunctionName,
  rustIdentifier,
  rustReaderName,
  splitHaskellCellSource,
  splitCellSource
} from '../../packages/oxiquill/src/generator/doc-runtime-core.mjs';

const requireFromPackage = createRequire(resolve(process.cwd(), 'packages/oxiquill/package.json'));
const { parse: parseToml } = requireFromPackage('smol-toml');

const highlighter = {
  codeToHtml: (source, options) => Promise.resolve(`<pre data-lang="${options.lang}">${source}</pre>`)
};

describe('Rust macro invocation scanning', () => {
  const families = [
    ['println', [], []],
    ['emit_text', ['text'], []],
    ['emit_json', ['json'], []],
    ['emit_html', ['html'], []],
    ['emit_image_svg', ['image'], []],
    ['emit_image_png', ['image'], []],
    ['emit_svg', ['image'], ['emit_image_svg']],
    ['emit_png_base64', ['image'], ['emit_image_png']],
    ['emit_table', ['table'], []],
    ['emit_table_with_columns', ['table'], []],
    ['emit_records_table', ['table'], []],
    ['emit_line_plot', ['chart', 'legacyPlot'], []],
    ['emit_line_chart', ['chart', 'lineChart'], []],
    ['emit_scatter_chart', ['chart', 'scatterChart'], []],
    ['emit_bar_chart', ['chart', 'barChart'], []],
    ['emit_histogram', ['chart', 'histogramChart'], []],
    ['emit_heatmap', ['chart', 'heatmapChart'], []]
  ];
  const empty = rustSourceCapabilities('');
  const declarations = (source) =>
    [...generateRustPreludeMacros(source).matchAll(/macro_rules! (\w+)/gu)].map((match) => match[1]).sort();

  describe.each(families)('%s', (name, capabilities, dependencies) => {
    it.each(['', ' ', '\n\t', '/**/', ' /* outer /* nested */ comment */\n// trivia\n'])(
      'accepts trivia %j',
      (trivia) => {
        const source = `${name}${trivia}!(&value);`;
        expect(rustSourceCapabilities(source)).toEqual({
          ...empty,
          ...Object.fromEntries(capabilities.map((key) => [key, true]))
        });
        expect(declarations(source)).toEqual([name, ...dependencies].sort());
      }
    );

    it.each([
      ['line comment', (call) => `// ${call}`],
      ['nested block comment', (call) => `/* outside /* ${call} */ ${call} */`],
      ['string', (call) => `let s = "${call}";`],
      ['escaped string', (call) => `let s = "\\"${call}\\\\";`],
      ['byte string', (call) => `let s = b"${call}";`],
      ['raw string', (call) => `let s = r"${call}";`],
      ['raw byte string', (call) => `let s = br###""# ${call} "##"###;`],
      ['raw C string', (call) => `let s = cr##"${call}"##;`],
      ['character and string', (call) => `let quote = '"'; let s = "${call}";`],
      ['byte character and string', (call) => `let quote = b'"'; let s = b"${call}";`],
      ['prefix identifier', (call) => `my_${call}`],
      ['suffix identifier', () => `${name}_extra!(&value);`],
      ['Unicode prefix', (call) => `変数${call}`],
      ['Unicode suffix', () => `${name}変数!(&value);`],
      ['numeric suffix', (call) => `1${call}`],
      ['lifetime', () => `'${name} !`],
      ['raw lifetime', () => `'r#${name} !`],
      ['inequality', () => `${name} != value`],
      ['intervening punctuation', () => `${name} + !value`]
    ])('ignores %s', (_label, wrap) => {
      const source = wrap(`${name}!(&value);`);
      expect(rustSourceCapabilities(source)).toEqual(empty);
      expect(declarations(source)).toEqual([]);
    });
  });

  it.each([0, 1, 8, 255])('matches exactly %i raw string delimiters', (count) => {
    const hashes = '#'.repeat(count);
    const source = `r${hashes}"emit_json! ${count ? `"${hashes.slice(1)} emit_html!` : ''}"${hashes}; emit_text ! ("ok");`;
    expect(scanRustMacroInvocations(source)).toEqual(new Set(['emit_text']));
  });

  it.each(["'a'", "b'!'", "'🦀'", String.raw`'\''`, String.raw`b'\x27'`, String.raw`'\u{1f980}'`, String.raw`'\\'`])(
    'skips character %s without swallowing subsequent code',
    (literal) => {
      expect(scanRustMacroInvocations(`let c = ${literal}; emit_json /* trivia */ !(&value);`)).toEqual(
        new Set(['emit_json'])
      );
    }
  );

  it('recognizes raw identifiers and Unicode macros without mistaking lifetimes or labels for calls', () => {
    expect(
      scanRustMacroInvocations("fn f<'a>(s: &'a str) { 'outer: loop { r#emit_json ! (s); 変数!(); break 'outer; } }")
    ).toEqual(new Set(['emit_json', '変数']));
  });

  it('unions capabilities and declares wrappers and their dependencies once', () => {
    const source = 'emit_svg!(); emit_svg !(); emit_image_svg!(); emit_json!(); emit_json !();';
    expect(scanRustMacroInvocations(source)).toEqual(new Set(['emit_svg', 'emit_image_svg', 'emit_json']));
    expect(declarations(source)).toEqual(['emit_image_svg', 'emit_json', 'emit_svg']);
    expect(rustSourceCapabilities(source)).toEqual({ ...empty, image: true, json: true });
    const cells = [
      { id: 'first', inputs: [], source: '// emit_html!()' },
      { id: 'second', inputs: [], source }
    ];
    expect(rustOutputCapabilities(cells)).toEqual({ ...empty, image: true, json: true });
    const generated = generateRustLib(cells);
    expect(generated).toContain('Json(JsonArtifact)');
    expect(generated).toContain('Image(ImageArtifact)');
    expect(generated).not.toContain('Html(HtmlArtifact)');
    expect(generated.match(/macro_rules! emit_svg/gu)).toHaveLength(1);
  });

  it.each([
    ['/* unfinished', 'block comment'],
    ['/* outer /* nested */', 'block comment'],
    ['"unfinished', 'string literal'],
    ['b"unfinished\\', 'string literal'],
    ['r"unfinished', 'raw string literal'],
    ['br##"unfinished"#', 'raw string literal'],
    [String.raw`'\x27`, 'character literal'],
    ["b'x", 'byte character literal']
  ])('reports unterminated %s with cell and source location', (source, kind) => {
    const cell = { id: 'broken', pagePath: 'content/docs/broken.mdx', inputs: [], source: `\n${source}` };
    expect(() => generateRustLib([cell])).toThrow(
      `Rust cell "broken" in content/docs/broken.mdx has an unterminated ${kind} at line 2, column`
    );
    expect(() => generateRustFunction(cell)).toThrow('Rust cell "broken"');
    expect(() => rustSourceCapabilities(source)).toThrow(`Rust source has an unterminated ${kind}`);
  });

  it('does not close lexical constructs using another cell source', () => {
    expect(() =>
      rustOutputCapabilities([
        { id: 'one', source: '/*' },
        { id: 'two', source: '*/ emit_json!();' }
      ])
    ).toThrow('Rust cell "one" has an unterminated block comment');
  });
});

describe('Rust cell author scope', () => {
  it('keeps inputs and author bindings inside a discarded block after macro definitions', () => {
    const source =
      'let __stdout = label;\nlet __outputs = 42;\nprintln!("{__stdout}:{__outputs}");\nemit_text!(__stdout);\n42';
    const generated = generateRustFunction({
      id: 'scope',
      inputs: [{ name: 'label', type: 'text' }],
      source
    });
    const block = generated.indexOf('    let _ = {');
    expect(generated.indexOf('let __stdout = std::cell::RefCell')).toBeLessThan(block);
    expect(generated.indexOf('let __outputs = std::cell::RefCell')).toBeLessThan(block);
    expect(generated.indexOf('macro_rules! println')).toBeLessThan(block);
    expect(generated.indexOf('macro_rules! emit_text')).toBeLessThan(block);
    expect(generated.slice(block)).toContain('        let label = read_string(inputs, "label")?;');
    expect(generated.slice(block)).toContain(
      source
        .split('\n')
        .map((line) => `        ${line}`)
        .join('\n')
    );
    expect(generated).toContain('        42\n    };\n\n    Ok(finish_cell_output(');
    expect(generated.slice(generated.indexOf('    Ok(finish_cell_output('))).toContain('__stdout.into_inner()');
  });
});

const helperCrates = new Map([
  ['doc-rust', { name: 'doc-rust', relativePath: '../../crates/doc-rust' }],
  ['doc-rust-text', { name: 'doc-rust-text', relativePath: '../../crates/doc-rust-text' }]
]);
const runtimeInputs = {
  package: { repository: 'https://example.com/oxiquill', version: '1.2.3' },
  rust: {
    dependencies: {
      console_error_panic_hook: '0.1.7',
      serde: '1.0.228',
      serde_json: '1.0.150',
      'wasm-bindgen': '0.2.122',
      'wasm-bindgen-test': '0.3.72'
    },
    edition: '2024',
    rustVersion: '1.95'
  }
};

function makeHaskellCell(source, overrides = {}) {
  return {
    id: 'haskell-cell',
    pagePath: 'content/docs/page.mdx',
    language: 'haskell',
    source,
    inputs: [],
    ...overrides
  };
}

describe('doc runtime core', () => {
  it('creates stable page-scoped authoring ids', () => {
    expect(pageIdFromPath('content/docs/ja/notes/example.mdx')).toBe('ja__notes__example');
    expect(relativePagePath('/repo', '/repo/content/docs/page.mdx')).toBe('content/docs/page.mdx');
    expect(relativePagePath('', '/repo/content/docs/page.mdx')).toBeUndefined();
    expect(scopedCellId('content/docs/page.mdx', 'cell id')).toBe('page__cell-id');
    expect(scopedCellId('', '---')).toBe('cell');
  });

  it('parses supported language aliases and ignores unknown languages', () => {
    expect(parseLanguage('rust')).toBe('rust');
    expect(parseLanguage('{rs} title')).toBe('rust');
    expect(parseLanguage('.py')).toBe('python');
    expect(parseLanguage('haskell')).toBe('haskell');
    expect(parseLanguage('{hs} title')).toBe('haskell');
    expect(parseLanguage('mermaid')).toBeUndefined();
  });

  it('splits metadata lines from executable source lines', () => {
    expect(splitCellSource('//| id: sample\nprintln!("ok");\n//| title: source', 'rust')).toEqual({
      kind: 'cell',
      metadataLines: ['id: sample'],
      sourceLines: ['println!("ok");', '//| title: source']
    });
    expect(splitCellSource('///| id: doc\n///| title: Rust docs\n#| title: source', 'rust')).toEqual({
      kind: 'cell',
      metadataLines: ['id: doc', 'title: Rust docs'],
      sourceLines: ['#| title: source']
    });
    expect(splitCellSource('--| id: hs\nputStrLn "ok"', 'haskell')).toEqual({
      kind: 'cell',
      metadataLines: ['id: hs'],
      sourceLines: ['putStrLn "ok"']
    });
    expect(splitCellSource('println!("plain");', 'rust')).toEqual({ kind: 'skip' });
    expect(splitCellSource('#| id: wrong\nprintln!("wrong");', 'rust')).toMatchObject({
      kind: 'invalid',
      diagnostics: [{ fieldPath: 'metadata' }]
    });
  });

  it('parses legal Markdown fences through the shared AST boundary', async () => {
    const source = [
      '   ````{.rust} title',
      '   //| id: rust-cell',
      '   //| title: Rust cell',
      '   //| run: reactive',
      '   //| crates: [doc-rust]',
      '   //| timeoutMs: 42',
      '   //| showSource: false',
      '   //| inputs:',
      '   //|   r: { type: range, label: r, min: 0, max: 4, step: 0.1, value: 3.2 }',
      '   println!("{r}");',
      '   `````',
      '~~~python',
      '#| id: python-cell',
      'print("ok")',
      '~~~~',
      '```haskell',
      '--| id: haskell-cell',
      'putStrLn "ok"',
      '```',
      '```rust',
      'println!("plain");',
      '```'
    ].join('\n');

    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells).toMatchObject([
      { id: 'page__rust-cell', language: 'rust', fenceStartLine: 1, timeoutMs: 42 },
      { id: 'page__python-cell', language: 'python', fenceStartLine: 12 },
      { id: 'page__haskell-cell', language: 'haskell', fenceStartLine: 16 }
    ]);

    const cells = await extractCellsFromMarkdown(source, 'content/docs/page.mdx', { helperCrates, highlighter });
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({
      id: 'page__rust-cell',
      title: 'Rust cell',
      run: 'reactive',
      crates: ['doc-rust'],
      packages: [],
      showSource: false,
      pagePath: 'content/docs/page.mdx'
    });
    expect(cells[0].inputs).toHaveLength(1);
    expect(cells[0].sourceHtml).toContain('data-lang="rust"');
  });

  it('parses MDX math before discovering interactive cells', () => {
    const source = [
      'Inline math: $\\text{hello world}$.',
      '',
      'Complex inline math: $\\operatorname{arg max}_{x \\in X} f(x)$.',
      '',
      '$$',
      '\\begin{aligned}',
      'f(x) &= {x + 1} \\\\',
      'g(x) &= \\frac{x}{2}',
      '\\end{aligned}',
      '$$',
      '',
      '```python',
      '#| id: math-cell',
      'print("ok")',
      '```'
    ].join('\n');

    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');
    const inlineMathNodes = parsed.tree.children
      .flatMap((node) => node.children ?? [])
      .filter((node) => node.type === 'inlineMath');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells).toMatchObject([
      {
        id: 'page__math-cell',
        language: 'python',
        source: 'print("ok")',
        fenceStartLine: 12
      }
    ]);
    expect(inlineMathNodes).toMatchObject([
      { type: 'inlineMath', value: '\\text{hello world}' },
      { type: 'inlineMath', value: '\\operatorname{arg max}_{x \\in X} f(x)' }
    ]);
    expect(parsed.tree.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'math',
          value: ['\\begin{aligned}', 'f(x) &= {x + 1} \\\\', 'g(x) &= \\frac{x}{2}', '\\end{aligned}'].join('\n')
        })
      ])
    );
  });

  it('rejects malformed MDX outside math spans', () => {
    const source = 'Valid math $\\text{ok}$ and invalid MDX {not valid JavaScript here}.';

    expect(() => parseCellsFromMarkdown(source, 'content/docs/page.mdx')).toThrow(
      'Could not parse expression with acorn'
    );
  });

  it.each([
    ['malformed YAML', '//| id: [', 'metadata'],
    ['invalid id', '//| id: Bad.id', 'id'],
    ['unknown field', '//| id: bad\n//| mystery: true', 'mystery'],
    ['non-string title', '//| id: bad\n//| title: 12', 'title'],
    ['non-boolean source flag', '//| id: bad\n//| showSource: "false"', 'showSource'],
    ['hidden run mode', '//| id: bad\n//| run: hidden', 'run'],
    ['fractional timeout', '//| id: bad\n//| timeoutMs: 1.5', 'timeoutMs'],
    ['wrong crates collection', '//| id: bad\n//| crates: doc-rust', 'crates'],
    ['duplicate crates', '//| id: bad\n//| crates: [doc-rust, doc-rust]', 'crates[1]'],
    ['language mismatch', '//| id: bad\n//| packages: [numpy]', 'packages'],
    ['autorun inputs', '//| id: bad\n//| run: autorun\n//| inputs: {}', 'inputs'],
    ['invalid input name', '//| id: bad\n//| inputs:\n//|   camelCase: { value: text }', 'inputs.camelCase'],
    ['scalar input definition', '//| id: bad\n//| inputs:\n//|   label: text', 'inputs.label'],
    ['wrong inputs collection', '//| id: bad\n//| inputs: []', 'inputs'],
    ['unknown input type', '//| id: bad\n//| inputs:\n//|   count: { type: knob, value: text }', 'inputs.count.type'],
    [
      'wrong input value type',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, value: text }',
      'inputs.count.value'
    ],
    [
      'wrong input label type',
      '//| id: bad\n//| inputs:\n//|   count: { label: 2, value: text }',
      'inputs.count.label'
    ],
    ['empty input label', '//| id: bad\n//| inputs:\n//|   count: { label: "  ", value: text }', 'inputs.count.label'],
    [
      'wrong input description type',
      '//| id: bad\n//| inputs:\n//|   count: { description: 2, value: text }',
      'inputs.count.description'
    ],
    [
      'empty input description',
      '//| id: bad\n//| inputs:\n//|   count: { description: "  ", value: text }',
      'inputs.count.description'
    ],
    [
      'wrong integer flag type',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, integer: yes, value: 1 }',
      'inputs.count.integer'
    ],
    [
      'integer flag on text',
      '//| id: bad\n//| inputs:\n//|   label: { integer: false, value: text }',
      'inputs.label.integer'
    ],
    ['numeric field on text', '//| id: bad\n//| inputs:\n//|   label: { value: text, min: 1 }', 'inputs.label.min'],
    [
      'non-finite bound',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, value: 1, max: .nan }',
      'inputs.count.max'
    ],
    [
      'non-positive step',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, value: 1, step: 0 }',
      'inputs.count.step'
    ],
    [
      'reversed bounds',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, value: 2, min: 3, max: 1 }',
      'inputs.count.min'
    ],
    [
      'default below bounds',
      '//| id: bad\n//| inputs:\n//|   count: { type: number, value: 0, min: 1 }',
      'inputs.count.value'
    ],
    [
      'fractional integer',
      '//| id: bad\n//| inputs:\n//|   count: { type: integer, value: 1.5 }',
      'inputs.count.value'
    ],
    [
      'integer default below portable domain',
      '//| id: bad\n//| inputs:\n//|   count: { type: integer, value: -2147483649 }',
      'inputs.count.value'
    ],
    [
      'integer maximum above portable domain',
      '//| id: bad\n//| inputs:\n//|   count: { type: integer, value: 1, max: 2147483648 }',
      'inputs.count.max'
    ],
    [
      'integer step above portable domain',
      '//| id: bad\n//| inputs:\n//|   count: { type: integer, value: 1, step: 2147483648 }',
      'inputs.count.step'
    ],
    [
      'empty options',
      '//| id: bad\n//| inputs:\n//|   mode: { type: select, value: a, options: [] }',
      'inputs.mode.options'
    ],
    [
      'duplicate options',
      '//| id: bad\n//| inputs:\n//|   mode: { type: radio, value: a, options: [a, a] }',
      'inputs.mode.options[1].value'
    ],
    [
      'missing option default',
      '//| id: bad\n//| inputs:\n//|   mode: { type: select, value: b, options: [a] }',
      'inputs.mode.value'
    ],
    ['options on text', '//| id: bad\n//| inputs:\n//|   mode: { value: a, options: [a] }', 'inputs.mode.options'],
    [
      'invalid option mapping',
      '//| id: bad\n//| inputs:\n//|   mode: { type: select, value: a, options: [{ label: A }] }',
      'inputs.mode.options[0].value'
    ],
    [
      'unknown option field',
      '//| id: bad\n//| inputs:\n//|   mode: { type: select, value: a, options: [{ label: A, value: a, extra: true }] }',
      'inputs.mode.options[0].extra'
    ],
    [
      'unknown input field',
      '//| id: bad\n//| inputs:\n//|   mode: { value: text, unknown: true }',
      'inputs.mode.unknown'
    ]
  ])('reports strict metadata diagnostics for %s', (_name, metadata, fieldPath) => {
    const source = ['before', '```rust', metadata, 'println!("ok");', '```'].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.cells).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        pagePath: 'content/docs/page.mdx',
        fenceStartLine: 2,
        fieldPath
      })
    );
  });

  it.each([
    ['empty', '""', 'Expected a non-empty string.'],
    ['whitespace-only', '"   "', 'Expected a non-empty string.'],
    ['non-string', '12', 'Expected a string.']
  ])('rejects an explicitly %s title with a title diagnostic', (_name, title, message) => {
    const source = ['```rust', '//| id: titled-cell', `//| title: ${title}`, 'println!("ok");', '```'].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.cells).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        pagePath: 'content/docs/page.mdx',
        fenceStartLine: 1,
        cellId: 'titled-cell',
        fieldPath: 'title',
        message
      })
    );
  });

  it('trims explicit titles and keeps the local id fallback for omitted titles', () => {
    const source = [
      '```rust',
      '//| id: explicit-title',
      '//| title: "  Example cell  "',
      'println!("explicit");',
      '```',
      '',
      '```python',
      '#| id: omitted-title',
      'print("omitted")',
      '```'
    ].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells).toMatchObject([
      { localId: 'explicit-title', title: 'Example cell' },
      { localId: 'omitted-title', title: 'omitted-title' }
    ]);
  });

  it.each([1, 2_147_483_647])('accepts the timeout boundary %s', (timeoutMs) => {
    const source = ['```python', '#| id: timeout-boundary', `#| timeoutMs: ${timeoutMs}`, 'print("ok")', '```'].join(
      '\n'
    );
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells[0].timeoutMs).toBe(timeoutMs);
  });

  it.each(['0', '-1', '1.5', '.nan', '.inf', '-.inf', '2147483648', '9007199254740991', '9007199254740992'])(
    'rejects timeoutMs %s outside the supported timer range',
    (timeoutMs) => {
      const source = ['```python', '#| id: invalid-timeout', `#| timeoutMs: ${timeoutMs}`, 'print("ok")', '```'].join(
        '\n'
      );
      const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

      expect(parsed.cells).toEqual([]);
      expect(parsed.diagnostics).toContainEqual(
        expect.objectContaining({
          fieldPath: 'timeoutMs',
          message: 'Expected an integer from 1 through 2147483647 milliseconds.'
        })
      );
    }
  );

  it('defaults timeoutMs to 30000 when the field is omitted', () => {
    const parsed = parseCellsFromMarkdown('```python\n#| id: default-timeout\nprint("ok")\n```', 'page.mdx');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells[0].timeoutMs).toBe(30_000);
  });

  it.each([
    ['button', 'number'],
    ['reactive', 'number'],
    ['button', 'range'],
    ['button', 'integer']
  ])('rejects a step-mismatched %s %s default before manifest generation', (run, type) => {
    const source = [
      '```python',
      '#| id: mismatched-default',
      `#| run: ${run}`,
      '#| inputs:',
      `#|   count: { type: ${type}, min: 0, step: 2, value: 1 }`,
      'print(count)',
      '```'
    ].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.cells).toEqual([]);
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        fieldPath: 'inputs.count.value',
        message: 'Expected the default value to align with effective step 2 from base 0.'
      })
    );
  });

  it('accepts numeric defaults aligned to integer, decimal, scientific, and implicit step grids', () => {
    const source = [
      '```python',
      '#| id: aligned-defaults',
      '#| inputs:',
      '#|   integer: { type: integer, min: 0, step: 2, value: 4 }',
      '#|   decimal: { type: range, min: 0.1, step: 0.1, value: 0.3 }',
      '#|   scientific: { type: number, min: 1e-7, step: 1e-7, value: 3e-7 }',
      '#|   implicit_step: { type: number, min: 0, value: 2 }',
      '#|   default_base: { type: number, step: 2, value: 1 }',
      'print(integer, decimal, scientific, implicit_step, default_base)',
      '```'
    ].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells).toHaveLength(1);
  });

  it('normalizes strict input defaults and option mappings', () => {
    const source = [
      '```python',
      '#| id: inputs',
      '#| packages: [pandas, matplotlib]',
      '#| inputs:',
      '#|   plain: { label: Plain value, description: A public input description. }',
      '#|   enabled: { type: checkbox }',
      '#|   count: { type: number, integer: true, value: 2, min: 1, max: 3, step: 1 }',
      '#|   mode: { type: select, value: b, options: [a, { label: Bee, value: b }] }',
      'print(plain, enabled, count, mode)',
      '```'
    ].join('\n');
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells[0]).toMatchObject({ packages: ['matplotlib', 'pandas'] });
    expect(parsed.cells[0].inputs).toEqual([
      {
        name: 'plain',
        type: 'text',
        label: 'Plain value',
        description: 'A public input description.',
        value: '',
        min: undefined,
        max: undefined,
        step: undefined,
        integer: false,
        options: []
      },
      {
        name: 'enabled',
        type: 'checkbox',
        label: 'enabled',
        value: false,
        min: undefined,
        max: undefined,
        step: undefined,
        integer: false,
        options: []
      },
      { name: 'count', type: 'number', label: 'count', value: 2, min: 1, max: 3, step: 1, integer: true, options: [] },
      {
        name: 'mode',
        type: 'select',
        label: 'mode',
        value: 'b',
        min: undefined,
        max: undefined,
        step: undefined,
        integer: false,
        options: [
          { label: 'a', value: 'a' },
          { label: 'Bee', value: 'b' }
        ]
      }
    ]);
  });

  it('rejects a language-mismatched leading option block before generation', async () => {
    const source = '```rust\n#| id: wrong-language\nprintln!("wrong");\n```';
    const parsed = parseCellsFromMarkdown(source, 'content/docs/page.mdx');

    expect(parsed.diagnostics).toEqual([
      {
        pagePath: 'content/docs/page.mdx',
        fenceStartLine: 1,
        fieldPath: 'metadata',
        message: 'Expected Rust option comments at the start of the cell.'
      }
    ]);
    await expect(
      extractCellsFromMarkdown(source, 'content/docs/page.mdx', { helperCrates, highlighter })
    ).rejects.toThrow('content/docs/page.mdx:1 metadata: Expected Rust option comments');
  });

  it('validates uniqueness and derives helper crates from manifests', () => {
    expect(() =>
      assertUniqueCellIds([
        { id: 'one__a', pagePath: 'one' },
        { id: 'two__a', pagePath: 'two' }
      ])
    ).not.toThrow();
    expect(() =>
      assertUniqueCellIds([
        { id: 'page__a', pagePath: 'page' },
        { id: 'page__a', pagePath: 'page' }
      ])
    ).toThrow('Scoped cell id');

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
    expect(() =>
      assertUniqueRustFunctionNames([
        { id: 'page__a-b', pagePath: 'one' },
        { id: 'page__a_b', pagePath: 'two' }
      ])
    ).toThrow('both map to generated function "run_page_a_b"');
    expect(() =>
      assertUniqueHaskellInputBindings([
        { id: 'ok', pagePath: 'page', inputs: [{ name: 'value-a' }, { name: 'value_b' }] }
      ])
    ).not.toThrow();
    expect(() =>
      assertUniqueHaskellInputBindings([
        { id: 'bad', pagePath: 'page', inputs: [{ name: 'data' }, { name: 'cell-data' }] }
      ])
    ).toThrow('both map to Haskell binding "cell_data"');
    expect(() =>
      assertUniqueHaskellFunctionNames([
        { id: 'page__a-b', pagePath: 'one' },
        { id: 'page__a_b', pagePath: 'two' }
      ])
    ).toThrow('both map to generated function "run_page_a_b"');

    const crates = helperCratesFromManifests(
      [
        { content: '[package]\nname = "b-crate"\n', manifestPath: '/repo/crates/b/Cargo.toml' },
        { content: '[package]\nname = "a-crate"\n', manifestPath: '/repo/crates/a/Cargo.toml' }
      ],
      { rustCellsDir: '/repo/.oxiquill/rust-cells' }
    );

    expect(Array.from(crates.keys())).toEqual(['a-crate', 'b-crate']);
    expect(crates.get('a-crate')).toEqual({ name: 'a-crate', relativePath: '../../crates/a' });
    expect(helperCratesFromManifests([], { rustCellsDir: '/repo/.oxiquill/rust-cells' })).toEqual(new Map());
    expect(packageNameFromCargoToml('[package]\nname = "doc-rust"\n', '/repo/crates/doc-rust/Cargo.toml')).toBe(
      'doc-rust'
    );
    expect(packageNameFromCargoToml('[package]\nname = "補助-crate٢"\n', '/repo/crates/unicode/Cargo.toml')).toBe(
      '補助-crate٢'
    );
    expect(() => packageNameFromCargoToml('[dependencies]\nserde = "1"\n', '/repo/crates/bad/Cargo.toml')).toThrow(
      'missing a [package] table'
    );
    expect(() =>
      helperCratesFromManifests(
        [
          { content: '[package]\nname = "same"\n', manifestPath: '/repo/crates/a/Cargo.toml' },
          { content: '[package]\nname = "same"\n', manifestPath: '/repo/crates/b/Cargo.toml' }
        ],
        { rustCellsDir: '/repo/.oxiquill/rust-cells' }
      )
    ).toThrow('use duplicate package name');
  });

  it('quotes and parses every generated helper-crate dependency key in deterministic order', () => {
    const crates = new Map([
      ['ascii', { name: 'ascii', relativePath: '../../crates/ascii' }],
      ['hyphen-crate', { name: 'hyphen-crate', relativePath: '../../crates/hyphen' }],
      ['under_score', { name: 'under_score', relativePath: '../../crates/underscore' }],
      ['補助-crate٢', { name: '補助-crate٢', relativePath: '../../crates/unicode' }]
    ]);
    const manifest = generateRustCargoToml(
      [{ crates: ['補助-crate٢', 'under_score', 'hyphen-crate', 'ascii'] }],
      crates,
      runtimeInputs
    );

    const dependencyLines = [
      '"ascii" = { path = "../../crates/ascii" }',
      '"hyphen-crate" = { path = "../../crates/hyphen" }',
      '"under_score" = { path = "../../crates/underscore" }',
      '"補助-crate٢" = { path = "../../crates/unicode" }'
    ];
    const dependencyPositions = dependencyLines.map((line) => manifest.indexOf(line));
    expect(dependencyPositions.every((position) => position >= 0)).toBe(true);
    expect(dependencyPositions).toEqual([...dependencyPositions].sort((left, right) => left - right));
    expect(generateRustDependency('補助-crate٢', crates)).toBe('"補助-crate٢" = { path = "../../crates/unicode" }');

    const parsed = parseToml(manifest);
    expect(parsed.dependencies.ascii.path).toBe('../../crates/ascii');
    expect(parsed.dependencies['hyphen-crate'].path).toBe('../../crates/hyphen');
    expect(parsed.dependencies.under_score.path).toBe('../../crates/underscore');
    expect(parsed.dependencies['補助-crate٢'].path).toBe('../../crates/unicode');
  });

  it('generates manifest files and Rust support code', () => {
    const cells = [{ id: 'one', pagePath: 'page', language: 'rust', inputs: [] }];
    expect(generateCellsModule(cells)).toContain('export const cells');
    expect(generateCellsJson(cells)).toContain('"id": "one"');

    expect(generateRustCargoToml([], helperCrates, runtimeInputs)).not.toContain('doc-rust =');
    expect(generateRustCargoToml([], helperCrates, runtimeInputs)).toContain('license = "MIT OR Apache-2.0"');
    expect(generateRustCargoToml([], helperCrates, runtimeInputs)).toContain('version = "1.2.3"');
    expect(generateRustCargoToml([], helperCrates, runtimeInputs)).toContain(
      'repository = "https://example.com/oxiquill"'
    );
    expect(generateRustCargoToml([], helperCrates, runtimeInputs)).toContain('serde_json = "=1.0.150"');
    expect(generateRustCargoToml([{ crates: ['doc-rust'] }], helperCrates, runtimeInputs)).toContain(
      '"doc-rust" = { path = "../../crates/doc-rust" }'
    );
    expect(generateRustDependency('doc-rust', helperCrates)).toBe('"doc-rust" = { path = "../../crates/doc-rust" }');
    expect(() => generateRustDependency('missing', helperCrates)).toThrow('unknown Rust crate');

    expect(rustIdentifier('1-bad id')).toBe('cell_1_bad_id');
    expect(rustIdentifier('type')).toBe('cell_type');
    expect(rustIdentifier('match')).toBe('cell_match');
    expect(rustIdentifier('crate')).toBe('cell_crate');
    expect(rustFunctionName('cell-id')).toBe('run_cell_id');
    expect(rustFunctionName('page__cell')).toBe('run_page_cell');
    expect(rustReaderName({ type: 'checkbox' })).toBe('read_bool');
    expect(rustReaderName({ type: 'integer' })).toBe('read_i32');
    expect(rustReaderName({ type: 'text', integer: true })).toBe('read_i32');
    expect(rustReaderName({ type: 'range' })).toBe('read_f64');
    expect(rustReaderName({ type: 'number' })).toBe('read_f64');
    expect(rustReaderName({ type: 'text' })).toBe('read_string');

    expect(generateRustInputBinding({ name: 'value-name', type: 'number' })).toBe(
      'let value_name = read_f64(inputs, "value-name")?;'
    );
    expect(generateRustInputBinding({ name: 'type', type: 'text' })).toBe(
      'let cell_type = read_string(inputs, "type")?;'
    );
    expect(haskellIdentifier('1-bad id')).toBe('cell_1_bad_id');
    expect(haskellIdentifier('data')).toBe('cell_data');
    expect(haskellIdentifier('Type')).toBe('cell_Type');
    expect(haskellFunctionName('page__cell')).toBe('run_page_cell');
    expect(haskellReaderName({ type: 'checkbox' })).toBe('readBoolInput');
    expect(haskellReaderName({ type: 'integer' })).toBe('readIntInput');
    expect(haskellReaderName({ type: 'text', integer: true })).toBe('readIntInput');
    expect(haskellReaderName({ type: 'range' })).toBe('readDoubleInput');
    expect(haskellReaderName({ type: 'number' })).toBe('readDoubleInput');
    expect(haskellReaderName({ type: 'text' })).toBe('readStringInput');
    expect(generateHaskellInputBinding({ name: 'type', type: 'text' })).toBe(
      'cell_type <- readStringInput "type" raw_cell_type'
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
        'emit_image_png!("abc");',
        'emit_svg!("<svg />");',
        'emit_png_base64!("abc");'
      ].join('\n'),
      inputs: []
    };
    const tableCell = {
      id: 'table-cell',
      source: [
        'emit_table!(&rows);',
        'emit_table_with_columns!(&columns, &rows);',
        'emit_records_table!(&records);'
      ].join('\n'),
      inputs: []
    };
    const chartCell = {
      id: 'chart-cell',
      source: [
        'emit_line_chart!(&points, "n", "x");',
        'emit_scatter_chart!(&points);',
        'emit_bar_chart!(&categories, &values);',
        'emit_histogram!(&bins);',
        'emit_heatmap!(&heatmap);'
      ].join('\n'),
      inputs: []
    };
    expect(generateRustReaders([rustCell])).toContain('fn read_f64');
    expect(generateRustReaders([rustCell])).toContain('fn read_i32');
    expect(generateRustReaders([rustCell])).toContain('.and_then(Value::as_i64)');
    expect(generateHaskellMain([rustCell])).toContain('value >= -2147483648 && value <= 2147483647');
    expect(generateRustFunction(rustCell)).toContain('macro_rules! println');
    expect(generateRustFunction(rustCell)).toContain('macro_rules! emit_line_plot');
    expect(generateRustFunction(rustCell)).not.toContain('macro_rules! emit_json');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_json');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_image_svg');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_svg');
    expect(generateRustFunction(preludeCell)).toContain('macro_rules! emit_png_base64');
    expect(generateRustFunction(tableCell)).toContain('macro_rules! emit_table');
    expect(generateRustFunction(tableCell)).toContain('macro_rules! emit_table_with_columns');
    expect(generateRustFunction(tableCell)).toContain('macro_rules! emit_records_table');
    expect(generateRustFunction(chartCell)).toContain('macro_rules! emit_line_chart');
    expect(generateRustFunction(chartCell)).toContain('macro_rules! emit_scatter_chart');
    expect(generateRustFunction(chartCell)).toContain('macro_rules! emit_bar_chart');
    expect(generateRustFunction(chartCell)).toContain('macro_rules! emit_histogram');
    expect(generateRustFunction(chartCell)).toContain('macro_rules! emit_heatmap');
    expect(generateRustFunction(rustCell)).toContain('Ok(finish_cell_output');
    expect(generateRustFunction({ id: 'plain', source: 'let value = 1;', inputs: [] })).toContain(
      'let __stdout = std::cell::RefCell::new(BoundedText::new());'
    );
    expect(generateRustLib([])).toContain('let _: Value = serde_json::from_str(inputs_json)');
    expect(generateRustLib([])).toContain('unknown Rust cell');
    const plainRustLib = generateRustLib([{ id: 'plain', source: 'println!("ok");', inputs: [] }]);
    expect(plainRustLib).not.toContain('fn bound_output_artifact');
    expect(plainRustLib).not.toContain('fn push(&mut self, artifact: OutputArtifact)');
    expect(plainRustLib).not.toContain('OutputArtifact::Json(json)');
    expect(plainRustLib).not.toContain('OutputArtifact::Html(html)');
    expect(plainRustLib).not.toContain('OutputArtifact::Image(image)');
    expect(generateRustLib([rustCell])).toContain('enum OutputArtifact');
    expect(generateRustLib([rustCell])).toContain('outputs: Vec<OutputArtifact>');
    expect(generateRustLib([preludeCell])).toContain('Json(JsonArtifact)');
    expect(generateRustLib([preludeCell])).toContain('Html(HtmlArtifact)');
    expect(generateRustLib([preludeCell])).toContain('Image(ImageArtifact)');
    expect(generateRustLib([preludeCell])).toContain('struct OutputCollector');
    expect(generateRustLib([preludeCell])).toContain('fn serialize_cell_output');
    expect(generateRustLib([tableCell])).toContain('row_count > 10000');
    expect(generateRustLib([preludeCell])).toContain('fn json_artifact');
    expect(generateRustLib([preludeCell])).toContain('fn html_artifact');
    expect(generateRustLib([preludeCell])).toContain('fn image_artifact');
    expect(generateRustLib([tableCell])).toContain('Table(TableArtifact)');
    expect(generateRustLib([tableCell])).toContain('fn table_artifact_from_value');
    expect(generateRustLib([tableCell])).toContain('row_count: usize');
    expect(generateRustLib([chartCell])).toContain('Chart(ChartArtifact)');
    expect(generateRustLib([chartCell])).toContain('fn xy_chart_spec');
    expect(generateRustLib([chartCell])).toContain('fn bar_chart_spec');
    expect(generateRustLib([chartCell])).toContain('fn histogram_chart_spec');
    expect(generateRustLib([chartCell])).toContain('fn heatmap_chart_spec');
    expect(generateRustLib([chartCell])).toContain('fn ensure_chart_data_limit');
    expect(generateRustLib([rustCell])).toContain('generated_plot_cell_runs');
    expect(generateRustLib([rustCell])).toContain('generated_output_limits_are_enforced');

    const haskellCell = {
      id: 'haskell-cell',
      pagePath: 'page',
      language: 'haskell',
      source: [
        '-- a leading comment should not block lifted pragmas and imports',
        '{-# LANGUAGE ScopedTypeVariables #-}',
        '-- an import comment should not become generated do-block code',
        'import Data.List (intercalate)',
        'let values = map (* scale) [1, 2, 3 :: Int]',
        'putStrLn (label ++ ": " ++ intercalate "," (map show values))'
      ].join('\n'),
      inputs: [
        { name: 'scale', type: 'integer' },
        { name: 'label', type: 'text' }
      ]
    };
    expect(splitHaskellCellSource(haskellCell)).toEqual({
      pragmas: ['{-# LANGUAGE ScopedTypeVariables #-}'],
      imports: ['import Data.List (intercalate)'],
      body: [
        'let values = map (* scale) [1, 2, 3 :: Int]',
        'putStrLn (label ++ ": " ++ intercalate "," (map show values))'
      ].join('\n')
    });
    expect(generateHaskellFunction(haskellCell)).toContain('scale <- readIntInput "scale" raw_scale');
    expect(generateHaskellFunction(haskellCell)).toContain('label <- readStringInput "label" raw_label');
    expect(generateHaskellFunction(haskellCell)).toContain('putStrLn');
    expect(generateHaskellMain([haskellCell])).toContain('module Main (main) where');
    expect(generateHaskellMain([haskellCell])).toContain('import Data.List (intercalate)');
    expect(generateHaskellMain([haskellCell])).toContain('"haskell-cell" -> run_haskell_cell inputValues');
    expect(generateHaskellMain([])).toContain('unknown Haskell cell');
    expect(() => splitHaskellCellSource({ ...haskellCell, source: 'module Example where\nmain = pure ()' })).toThrow(
      'cannot declare a module'
    );
  });

  it('extracts multiline Haskell pragmas and imports through nested preamble comments', () => {
    const source = [
      '{- explain the preamble {- including a nested comment -} -}',
      'import Data.List',
      '  ( intercalate',
      '  -- keep comments inside a declaration valid',
      '  , sort',
      '  )',
      '{- interstitial {- nested -} comment -}',
      '{-# LANGUAGE',
      '  ScopedTypeVariables',
      '#-}',
      'putStrLn (intercalate "," (sort values))'
    ].join('\n');

    expect(splitHaskellCellSource(makeHaskellCell(source))).toEqual({
      pragmas: ['{-# LANGUAGE\n  ScopedTypeVariables\n#-}'],
      imports: ['import Data.List\n  ( intercalate\n  -- keep comments inside a declaration valid\n  , sort\n  )'],
      body: 'putStrLn (intercalate "," (sort values))'
    });
  });

  it('extracts qualified, import-as, and hiding forms split across lines', () => {
    const source = [
      'import qualified',
      '  Data.Map.Strict',
      '  as',
      '  Map',
      '  hiding',
      '  ( map',
      '  , null',
      '  )',
      'print (Map.size values)'
    ].join('\n');

    expect(splitHaskellCellSource(makeHaskellCell(source))).toEqual({
      pragmas: [],
      imports: [
        ['import qualified', '  Data.Map.Strict', '  as', '  Map', '  hiding', '  ( map', '  , null', '  )'].join('\n')
      ],
      body: 'print (Map.size values)'
    });
  });

  it('ignores module declaration text in comments, strings, and character literals', () => {
    const source = ['{- module Commented where -}', 'putStrLn "module Example where"', "print 'm'"].join('\n');

    expect(splitHaskellCellSource(makeHaskellCell(source)).body).toBe(
      ['putStrLn "module Example where"', "print 'm'"].join('\n')
    );
  });

  it('rejects a real Haskell module declaration with cell and page context', () => {
    const cell = makeHaskellCell('module Example (main) where\nmain = pure ()', {
      id: 'module-cell',
      pagePath: 'content/docs/module.mdx'
    });

    expect(() => splitHaskellCellSource(cell)).toThrow(
      'Haskell cell "module-cell" in content/docs/module.mdx cannot declare a module; write a snippet body instead.'
    );
  });

  it('preserves imports and pragma-looking text after the first body token', () => {
    const body = ['putStrLn "start"', 'import Data.List (sort)', '{-# LANGUAGE LambdaCase #-}'].join('\n');

    expect(splitHaskellCellSource(makeHaskellCell(body))).toEqual({ body, imports: [], pragmas: [] });
  });

  it.each([
    ['block comment', '{- unfinished', 'unterminated block comment'],
    ['pragma', '{-# LANGUAGE LambdaCase', 'unterminated pragma'],
    ['string literal', 'putStrLn "unfinished', 'unterminated string literal'],
    ['character literal', "print 'x", 'unterminated character literal'],
    ['import list', 'import Data.List (sort', 'unbalanced import list']
  ])('reports an unterminated Haskell %s with cell context', (_name, source, message) => {
    expect(() => splitHaskellCellSource(makeHaskellCell(source))).toThrow(
      `Haskell cell "haskell-cell" in content/docs/page.mdx has an ${message}.`
    );
  });

  it('keeps the empty Haskell body fallback after lifting declarations', () => {
    expect(generateHaskellFunction(makeHaskellCell('import Data.List (sort)'))).toContain('    pure ()');
  });

  it('detects Rust output capabilities from source tokens', () => {
    expect(rustSourceCapabilities('emit_json!(&value);\nemit_table!(&rows);')).toMatchObject({
      chart: false,
      image: false,
      json: true,
      table: true
    });

    expect(rustSourceCapabilities('emit_svg!("<svg />");\nemit_heatmap!(&data);')).toMatchObject({
      chart: true,
      heatmapChart: true,
      image: true
    });
  });

  it('selects only required generated Rust macros', () => {
    const macros = generateRustPreludeMacros('emit_svg!("<svg />");\nemit_table_with_columns!(&columns, &rows);');

    expect(macros).toContain('macro_rules! emit_image_svg');
    expect(macros).toContain('macro_rules! emit_svg');
    expect(macros).toContain('macro_rules! emit_table_with_columns');
    expect(macros).not.toContain('macro_rules! emit_json');
    expect(macros).not.toContain('macro_rules! emit_line_chart');
  });
});
