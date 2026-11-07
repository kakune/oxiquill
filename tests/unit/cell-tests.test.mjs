// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  parseCellsFromMarkdown,
  createCellManifest
} from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import { createGenerationSnapshot } from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';
import {
  evaluateExpectation,
  resolveJsonPointer,
  equalJson
} from '../../packages/oxiquill/src/lib/doc-runtime/cell-tests.mjs';
import { createCellTestPlan } from '../../packages/oxiquill/src/generator/doc-runtime/cell-test-plan.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';

const paths = createOxiquillPaths({ workspaceRoot: '/fixture' });
const parse = (metadata, language = 'rust') => {
  const prefix = { rust: '//|', python: '#|', haskell: '--|' }[language];
  return parseCellsFromMarkdown(
    [
      '',
      `\`\`\`${language}`,
      ...[
        'id: sample',
        'inputs: { n: { type: number, value: 1 } }',
        'cases: [{ id: named, label: Named, inputs: { n: 2 } }, { id: untested, label: Untested, inputs: {} }]',
        metadata
      ]
        .join('\n')
        .split('\n')
        .map((line) => `${prefix} ${line}`),
      'emit_json!(&n);',
      '```'
    ].join('\n'),
    'content/docs/guide.mdx'
  );
};

describe('declared test metadata', () => {
  it('preserves exact source locations and omits tests from reader manifests', async () => {
    const {
      cells: [cell],
      diagnostics
    } = parse(
      'tests:\n  - case: named\n    expect:\n      - { path: /outputs/0/value, approx: { value: 2, atol: 0.1 } }'
    );
    expect(diagnostics).toEqual([]);
    expect(cell.tests[0].expectationLocations[0]).toEqual({ line: 9, column: 13 });
    const manifest = await createCellManifest(cell, { codeToHtml: async () => '' });
    expect(manifest).not.toHaveProperty('tests');
    const before = createGenerationSnapshot([cell], []);
    const moved = structuredClone(cell);
    moved.tests[0].location.line += 10;
    moved.tests[0].expectationLocations[0].line += 10;
    expect(createGenerationSnapshot([moved], []).generationId).toBe(before.generationId);
    moved.tests[0].expect[0].approx.value = 3;
    expect(createGenerationSnapshot([moved], []).generationId).not.toBe(before.generationId);
  });

  it.each([
    ['tests: null', 'tests'],
    ['tests: [null]', 'tests[0]'],
    ['tests: [{ case: unknown, expect: [] }]', 'tests[0].case'],
    ['tests: [{ case: default, expect: [] }]', 'tests[0].expect'],
    ['tests: [{ case: default, expect: {} }]', 'tests[0].expect'],
    ['tests: [{ case: default, extra: true, expect: [{ error: x }] }]', 'tests[0].extra'],
    ['tests: [{ case: default, expect: [null] }]', 'tests[0].expect[0]'],
    ['tests: [{ case: default, expect: [{}] }]', 'tests[0].expect[0]'],
    ['tests: [{ case: default, expect: [{ path: "", equals: 1, range: { min: 0 } }] }]', 'tests[0].expect[0]'],
    ['tests: [{ case: default, expect: [{ error: x }, { error: y }] }]', 'tests[0].expect[0]'],
    ['tests: [{ case: default, expect: [{ error: "" }] }]', 'tests[0].expect[0].error'],
    ['tests: [{ case: default, expect: [{ error: 1 }] }]', 'tests[0].expect[0].error'],
    ['tests: [{ case: default, expect: [{ error: x, path: "" }] }]', 'tests[0].expect[0].path'],
    ['tests: [{ case: default, expect: [{ path: bad, equals: 1 }] }]', 'tests[0].expect[0].path'],
    ['tests: [{ case: default, expect: [{ path: /bad~2, equals: 1 }] }]', 'tests[0].expect[0].path'],
    ['tests: [{ case: default, expect: [{ path: "", artifact: 1, equals: 1 }] }]', 'tests[0].expect[0].artifact'],
    ['tests: [{ case: default, expect: [{ path: "", equals: .inf }] }]', 'tests[0].expect[0].equals'],
    ['tests: [{ case: default, expect: [{ path: "", range: {} }] }]', 'tests[0].expect[0].range'],
    ['tests: [{ case: default, expect: [{ path: "", range: [] }] }]', 'tests[0].expect[0].range'],
    ['tests: [{ case: default, expect: [{ path: "", range: { min: .nan } }] }]', 'tests[0].expect[0].range.min'],
    ['tests: [{ case: default, expect: [{ path: "", range: { min: 2, max: 1 } }] }]', 'tests[0].expect[0].range'],
    ['tests: [{ case: default, expect: [{ path: "", approx: { value: 0 } }] }]', 'tests[0].expect[0].approx'],
    [
      'tests: [{ case: default, expect: [{ path: "", approx: { value: .inf, atol: 1 } }] }]',
      'tests[0].expect[0].approx.value'
    ],
    [
      'tests: [{ case: default, expect: [{ path: "", approx: { value: 0, atol: -1 } }] }]',
      'tests[0].expect[0].approx.atol'
    ],
    [
      'tests: [{ case: default, expect: [{ path: "", approx: { value: 0, rtol: .inf } }] }]',
      'tests[0].expect[0].approx.rtol'
    ],
    ['tests: [{ case: default, expect: [{ error: x }] }, { case: default, expect: [{ error: y }] }]', 'tests[1].case']
  ])('rejects %s with field context', (metadata, fieldPath) => {
    expect(parse(metadata).diagnostics).toContainEqual(
      expect.objectContaining({
        fieldPath,
        pagePath: 'content/docs/guide.mdx',
        cellId: 'sample',
        line: expect.any(Number)
      })
    );
  });
  it.each(['python', 'haskell'])('rejects tests on %s', (language) => {
    expect(parse('tests: []', language).diagnostics[0].message).toBe(
      `tests are not yet supported for ${language} cells`
    );
  });
  it('validates error byte limits and cyclic equality values', () => {
    expect(
      parse(`tests: [{ case: default, expect: [{ error: '${'語'.repeat(86)}' }] }]`).diagnostics[0].fieldPath
    ).toBe('tests[0].expect[0].error');
    expect(
      parse('tests: [{ case: default, expect: [{ path: "", equals: &cycle [*cycle] }] }]').diagnostics[0].fieldPath
    ).toBe('tests[0].expect[0].equals');
  });
});

describe('expectation evaluation', () => {
  const outcome = (value) => ({ kind: 'result', result: { outputs: [{ id: 'summary', kind: 'json', value }] } });
  it('resolves RFC 6901 pointers without inherited or array pseudo-properties', () => {
    const value = { 'a/b': { '~x': [null, 'text'] }, '': 4 };
    expect(resolveJsonPointer(value, '')).toEqual({ found: true, value });
    expect(resolveJsonPointer(value, '/a~1b/~0x/0')).toEqual({ found: true, value: null });
    expect(resolveJsonPointer(value, '/')).toEqual({ found: true, value: 4 });
    ['/toString', '/a~1b/~0x/length', '/a~1b/~0x/01', '/a~1b/~0x/2', '/a~1b/~0x/0/x'].forEach((pointer) =>
      expect(resolveJsonPointer(value, pointer)).toEqual({ found: false })
    );
  });
  it('compares JSON objects structurally without coercion', () => {
    expect(equalJson({ b: [1, null], a: true }, { a: true, b: [1, null] })).toBe(true);
    [
      [1, '1'],
      [null, 0],
      [[], {}],
      [[1], [1, 2]],
      [{ a: 1 }, { b: 1 }]
    ].forEach(([a, b]) => expect(equalJson(a, b)).toBe(false));
  });
  it('handles bounded ranges and approximation near zero', () => {
    expect(
      evaluateExpectation({ artifact: 'summary', path: '/value', approx: { value: 0, atol: 1e-8 } }, outcome(1e-9))
    ).toBeUndefined();
    expect(
      evaluateExpectation({ path: '/outputs/0/value', approx: { value: 100, rtol: 0.01 } }, outcome(101))
    ).toBeUndefined();
    expect(
      evaluateExpectation({ artifact: 'summary', path: '/value', range: { min: 2, max: 2 } }, outcome(2))
    ).toBeUndefined();
    expect(evaluateExpectation({ artifact: 'summary', path: '/value', range: { max: 2 } }, outcome(3)).reason).toBe(
      'out-of-range'
    );
    expect(
      evaluateExpectation({ artifact: 'summary', path: '/value', approx: { value: 0, atol: 1e-8 } }, outcome(1)).reason
    ).toBe('not-approximate');
    [null, '0', true, Infinity].forEach((actual) =>
      expect(
        evaluateExpectation({ artifact: 'summary', path: '/value', range: { min: 0 } }, outcome(actual)).reason
      ).toBe('not-finite-number')
    );
  });
  it('distinguishes missing values, execution errors, and authored status values', () => {
    expect(evaluateExpectation({ artifact: 'absent', path: '', equals: null }, outcome(null)).reason).toBe(
      'missing-artifact'
    );
    expect(evaluateExpectation({ artifact: 'summary', path: '/absent', equals: null }, outcome(null)).reason).toBe(
      'missing-path'
    );
    expect(evaluateExpectation({ artifact: 'summary', path: '/value', equals: null }, outcome(null))).toBeUndefined();
    expect(
      evaluateExpectation(
        { artifact: 'summary', path: '/value/status', equals: 'failed' },
        outcome({ status: 'failed' })
      )
    ).toBeUndefined();
    expect(evaluateExpectation({ error: 'failed' }, outcome({ status: 'failed' })).reason).toBe('expected-error');
    expect(
      evaluateExpectation({ error: 'failure' }, { kind: 'execution-error', error: 'expected failure' })
    ).toBeUndefined();
    expect(evaluateExpectation({ path: '', equals: 1 }, { kind: 'execution-error', error: 'failure' }).reason).toBe(
      'execution-error'
    );
  });
});

describe('test selection', () => {
  const cell = () =>
    parse(
      'tests: [{ case: default, expect: [{ path: /outputs/0/value, equals: 1 }] }, { case: named, expect: [{ error: failed }] }]'
    ).cells[0];
  it('runs defaults and declared cases once, with resolved inputs', () => {
    const plan = createCellTestPlan([cell()], {}, paths);
    expect(plan.tests.map(({ case: id, inputs }) => [id, inputs])).toEqual([
      ['default', { n: 1 }],
      ['named', { n: 2 }]
    ]);
    expect(plan.tests[1].testIndex).toBe(1);
    expect(plan.runHaskell).toBe(true);
    expect(createCellTestPlan([{ ...cell(), tests: [] }], {}, paths).tests).toHaveLength(1);
    expect(createCellTestPlan([], {}, paths).tests).toEqual([]);
  });
  it('intersects selectors and enables extra smoke cases only with --all-cases', () => {
    const cells = [cell(), { ...cell(), pagePath: 'content/docs/other.mdx', id: 'other__sample' }];
    const plan = createCellTestPlan(
      cells,
      {
        page: ['./dir/../guide.mdx', 'guide.mdx'],
        cell: ['sample', 'guide__sample'],
        case: ['untested'],
        'all-cases': true
      },
      paths
    );
    expect(plan.tests).toHaveLength(1);
    expect(plan.tests[0]).toMatchObject({ case: 'untested', inputs: { n: 1 }, expect: [] });
    expect(plan.runHaskell).toBe(false);
    expect(
      createCellTestPlan(cells, { page: ['guide.mdx', 'other.mdx'], cell: ['other__sample'] }, paths).tests
    ).toHaveLength(2);
  });
  it.each([
    { page: ['absent.mdx'] },
    { page: ['../guide.mdx'] },
    { page: ['/guide.mdx'] },
    { page: ['C:\\guide.mdx'] },
    { cell: ['sample'] },
    { cell: ['guide__sample', 'absent'] },
    { page: ['guide.mdx'], cell: ['absent'] },
    { case: ['absent'] },
    { case: ['untested'] },
    { case: ['default', 'absent'] }
  ])('rejects unmatched or invalid selectors %j', (values) =>
    expect(() => createCellTestPlan([cell()], values, paths)).toThrow()
  );
  it('rejects explicit unsupported cells while ignoring them in ordinary Rust runs', () => {
    const python = { ...cell(), language: 'python', id: 'guide__python', localId: 'python' };
    expect(() => createCellTestPlan([python], { cell: [python.id] }, paths)).toThrow(
      'test cases are not yet supported for python cells'
    );
    expect(() => createCellTestPlan([python], { page: ['guide.mdx'] }, paths)).toThrow('no runnable Rust tests');
    expect(createCellTestPlan([python], {}, paths).tests).toEqual([]);
  });
});
