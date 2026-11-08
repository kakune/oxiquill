// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  mapRustSpan,
  mapRustDiagnostic,
  formatRustDiagnostic,
  compilerMessages,
  formatRustFailure,
  mapRustCompilerMessages
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-diagnostics.mjs';
import {
  generatedFragment,
  authoredFragment,
  joinFragments
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-codegen/source-map.mjs';
import { cellCompileErrors } from '../../packages/oxiquill/src/generator/doc-runtime/dev-diagnostics.mjs';

const cell = {
  id: 'demo__example',
  pagePath: 'content/docs/demo.mdx',
  source: 'let label = "日本語"; label.missing();\r\nlet n: u8 = "wrong";',
  sourcePosition: [
    { line: 15, column: 3, text: '  let label = "日本語"; label.missing();' },
    { line: 16, column: 3, text: '  let n: u8 = "wrong";' }
  ]
};
const generated = joinFragments([
  generatedFragment('fn wrapper() {\n', cell, 'wrapper'),
  authoredFragment(cell),
  generatedFragment('\n}', cell, 'wrapper')
]);
const file = { ...generated, file: '/repo/.oxiquill/rust-cells/src/lib.rs', crateDir: '/repo/.oxiquill/rust-cells' };
const offset = (text) => Buffer.byteLength(generated.text.slice(0, generated.text.indexOf(text)));
const span = (text, overrides = {}) => ({
  file_name: 'src/lib.rs',
  byte_start: offset(text),
  byte_end: offset(text) + Buffer.byteLength(text),
  line_start: 2,
  column_start: 1,
  is_primary: true,
  label: 'here',
  ...overrides
});
const message = (spans) => ({
  level: 'error',
  code: { code: 'E0599' },
  message: 'no method named missing',
  spans,
  children: []
});
const compilerOutput = JSON.stringify({ reason: 'compiler-message', message: message([span('missing')]) });

describe('Rust diagnostic attribution', () => {
  it('maps UTF-8 byte offsets into authored character columns and keeps generated locations', () => {
    const mapped = mapRustSpan(span('missing'), [file], '/repo');
    expect(mapped).toMatchObject({
      kind: 'authored',
      file: cell.pagePath,
      line: 15,
      column: 28,
      cellId: cell.id,
      endColumn: 35,
      generated: { file: 'src/lib.rs', line: 2 }
    });
    const formatted = formatRustDiagnostic(mapRustDiagnostic(message([span('missing')]), [file], '/repo'));
    expect(formatted).toContain(`${cell.pagePath}:15:28 [cell ${cell.id}]`);
    expect(formatted).toContain('^^^^^^^ here');
    expect(formatted.split('\n')).toContain(`  ${' '.repeat(30)}^^^^^^^ here`);
    expect(formatted).toContain('generated: src/lib.rs:2:1');
  });

  it('maps multiline spans and insertion points', () => {
    expect(mapRustSpan(span('label', { byte_end: offset('"wrong"') + 7 }), [file], '/repo')).toMatchObject({
      kind: 'authored',
      endLine: 16
    });
    expect(mapRustSpan(span('missing', { byte_end: offset('missing') }), [file], '/repo')).toMatchObject({
      kind: 'authored',
      endColumn: 28
    });
  });

  it('attributes wrappers explicitly and never assigns dependencies to a cell', () => {
    expect(mapRustSpan(span('wrapper'), [file], '/repo')).toMatchObject({
      kind: 'generated',
      cellId: cell.id,
      region: 'wrapper'
    });
    expect(
      mapRustSpan(span('missing', { file_name: '/repo/crates/helper/src/lib.rs' }), [file], '/repo')
    ).toMatchObject({ kind: 'external', file: '/repo/crates/helper/src/lib.rs' });
    expect(
      mapRustSpan(span('missing', { file_name: '/repo/crates/helper/src/lib.rs' }), [file], '/repo')
    ).not.toHaveProperty('cellId');
    expect(
      mapRustSpan(span('missing', { byte_end: Buffer.byteLength(generated.text) }), [file], '/repo')
    ).toMatchObject({ kind: 'generated' });
  });

  it('preserves child notes, secondary spans, and authored macro call sites', () => {
    const mapped = mapRustDiagnostic(
      {
        ...message([span('wrapper', { expansion: { span: span('missing') } }), span('"wrong"', { is_primary: false })]),
        children: [{ level: 'note', message: 'required here', spans: [], children: [] }]
      },
      [file],
      '/repo'
    );
    expect(formatRustDiagnostic(mapped)).toContain(`${cell.pagePath}:15:28`);
    expect(formatRustDiagnostic(mapped)).toContain('required here');
    expect(cellCompileErrors([mapped])).toContainEqual(
      expect.objectContaining({ cellId: cell.id, file: cell.pagePath })
    );
  });

  it('translates suggestions only if all edit spans are authored', () => {
    const authored = span('missing', { suggested_replacement: 'len', suggestion_applicability: 'MachineApplicable' });
    expect(mapRustDiagnostic(message([authored]), [file], '/repo').translatedSuggestion).toBe(true);
    const mixed = mapRustDiagnostic(
      { ...message([authored, span('wrapper', { suggested_replacement: 'other' })]), rendered: 'original suggestion' },
      [file],
      '/repo'
    );
    expect(mixed.translatedSuggestion).toBe(false);
    expect(formatRustDiagnostic(mixed)).toContain('untranslated suggestion: original suggestion');
  });

  it('handles global generated regions, unknown offsets, malformed JSON, and empty messages', () => {
    expect(compilerMessages('not json\n{}\n' + compilerOutput)).toHaveLength(1);
    expect(formatRustDiagnostic(mapRustDiagnostic({ level: 'note', message: 'note' }, [], '/repo'))).toBe('note');
    expect(mapRustSpan(span('missing', { byte_start: 9999, byte_end: 9999 }), [file], '/repo')).toMatchObject({
      kind: 'generated',
      region: 'support'
    });
    expect(joinFragments([generatedFragment('')])).toEqual({ text: '', regions: [] });
    expect(authoredFragment({ ...cell, sourcePosition: undefined }).regions[0].line).toBe(1);
  });

  const pagePath = [...Array(14).fill(''), ...cell.sourcePosition.map((position) => position.text)].join('\n');
  const paths = { workspaceRoot: '/repo', rustCellsDir: file.crateDir };

  it('maps messages captured from the build and keeps the original failure text', async () => {
    const result = await mapRustCompilerMessages({
      messages: compilerMessages(compilerOutput),
      files: [file],
      paths,
      fileSystem: { readFile: async (name) => (name.endsWith('.mdx') ? pagePath : generated.text) }
    });
    expect(result.unmapped).toBe(false);
    expect(result.diagnostics[0].spans[0]).toMatchObject({ kind: 'authored', cellId: cell.id });
    const message = formatRustFailure({ ...result, original: 'cargo exited with 101' });
    expect(message).toContain('demo.mdx:15');
    expect(message).toContain('Original build error:\ncargo exited with 101');
    expect(message).not.toContain('could not map');
  });

  it('reports unavailable mapping without replacing the original error', async () => {
    const result = await mapRustCompilerMessages({ messages: [], paths, fileSystem: {} });
    expect(formatRustFailure({ ...result, original: 'original' })).toContain(
      'could not map this error to an authored cell\n\nOriginal build error:\noriginal'
    );
  });

  it('rejects source maps for changed or unavailable generated files', async () => {
    for (const readFile of [
      async () => 'changed',
      async () => {
        throw new Error('missing');
      }
    ]) {
      const result = await mapRustCompilerMessages({
        messages: compilerMessages(compilerOutput),
        files: [file],
        paths,
        fileSystem: { readFile }
      });
      expect(result.unmapped).toBe(true);
      expect(result.diagnostics[0].spans[0].kind).toBe('external');
      expect(formatRustFailure({ ...result, original: 'x' })).toContain('could not map this error');
    }
  });

  it('rejects a previous page revision even when the old source lines still match', async () => {
    const stale = {
      ...file,
      regions: file.regions.map((region) =>
        region.kind === 'authored' ? { ...region, pageFingerprint: 'old page revision' } : region
      )
    };
    const result = await mapRustCompilerMessages({
      messages: compilerMessages(compilerOutput),
      files: [stale],
      paths,
      fileSystem: { readFile: async (name) => (name.endsWith('.mdx') ? pagePath : file.text) }
    });
    expect(result.unmapped).toBe(true);
    expect(result.diagnostics[0].spans[0].kind).toBe('external');
  });
  it('retains ownership on secondary generated spans', () => {
    const mapped = mapRustDiagnostic(
      message([span('missing'), span('wrapper', { is_primary: false })]),
      [file],
      '/repo'
    );
    expect(formatRustDiagnostic(mapped)).toContain(`[generated wrapper; cell ${cell.id}]`);
  });
});
