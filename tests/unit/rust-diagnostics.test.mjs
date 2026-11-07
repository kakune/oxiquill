// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  mapRustSpan,
  mapRustDiagnostic,
  formatRustDiagnostic,
  diagnoseRustFailure,
  compilerMessages,
  isRustCompilerFailure
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

  it.each([
    'wasm-pack exited with 1: download failed',
    'wasm-bindgen failed',
    'wasm-opt exited with 1',
    'error: failed to select a version',
    'error: failed to run custom build command; could not compile `helper`'
  ])('skips non-compiler failure %s', async (text) => {
    const error = new Error(text);
    const runCommand = vi.fn();
    expect(await diagnoseRustFailure({ error, runCommand })).toBe(error);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('runs one matching failure-only check and preserves the original failure status', async () => {
    const error = Object.assign(new Error('wasm-pack exited with 7'), {
      exitCode: 7,
      stderr: 'error[E0599]: no method\nerror: could not compile `doc-rust-cells`'
    });
    const runCommand = vi.fn().mockRejectedValue({ stdout: compilerOutput, exitCode: 101 });
    const result = await diagnoseRustFailure({
      error,
      files: [file],
      paths: { workspaceRoot: '/repo', rustCellsDir: file.crateDir },
      mode: 'build',
      env: { RUSTFLAGS: '--cfg test_cfg' },
      packages: ['example'],
      runCommand,
      fileSystem: {
        readFile: async (name) =>
          name.endsWith('.mdx')
            ? [...Array(14).fill(''), ...cell.sourcePosition.map((position) => position.text)].join('\n')
            : generated.text
      }
    });
    expect(result).toBe(error);
    expect(result.exitCode).toBe(7);
    expect(result.message).toContain('wasm-pack exited with 7');
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand.mock.calls[0][1]).toEqual([
      'check',
      '--manifest-path',
      '/repo/.oxiquill/rust-cells/Cargo.toml',
      '--locked',
      '--target',
      'wasm32-unknown-unknown',
      '--message-format=json',
      '--release',
      '--package',
      'example'
    ]);
    expect(runCommand.mock.calls[0][2].env.RUSTFLAGS).toBe('--cfg test_cfg');
  });

  it('reports unavailable mapping without replacing the original error when the check fails to reproduce', async () => {
    const error = Object.assign(new Error('original'), { stdout: compilerOutput });
    await diagnoseRustFailure({
      error,
      paths: { workspaceRoot: '/repo', rustCellsDir: file.crateDir },
      runCommand: async () => 'noise',
      fileSystem: {}
    });
    expect(error.message).toContain('could not map this error to an authored cell');
    expect(error.message).toContain('original');
    expect(isRustCompilerFailure({ message: 'other', stdout: compilerOutput })).toBe(true);
  });

  it('rejects source maps for changed or unavailable generated files', async () => {
    for (const readFile of [
      async () => 'changed',
      async () => {
        throw new Error('missing');
      }
    ]) {
      const error = Object.assign(new Error('original'), { stdout: compilerOutput });
      await diagnoseRustFailure({
        error,
        files: [file],
        paths: { workspaceRoot: '/repo', rustCellsDir: file.crateDir },
        runCommand: async () => compilerOutput,
        fileSystem: { readFile }
      });
      expect(error.rustDiagnostics[0].spans[0].kind).toBe('external');
    }
  });
});
