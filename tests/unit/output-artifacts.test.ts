import { describe, expect, it } from 'vitest';
import {
  isOutputArtifact,
  type NormalizedCellExecutionResult,
  normalizeCellExecutionResult
} from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';

function publicResult(result: NormalizedCellExecutionResult) {
  const publicFields = { ...result };
  Reflect.deleteProperty(publicFields, 'outputResults');
  return publicFields;
}

describe('output artifact normalization', () => {
  it('requires an outputs array and diagnoses obsolete results without invoking getters', () => {
    const getter = {
      get outputs() {
        throw new Error('Getter must not run');
      }
    };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const result of [undefined, null, {}, { stdout: 'old', plots: [] }, { outputs: {} }, getter, revoked.proxy]) {
      const normalized = normalizeCellExecutionResult(result);
      expect(normalized.outputs).toEqual([]);
      expect(normalized.outputResults).toMatchObject([
        { status: 'error', message: expect.stringContaining('require an outputs array') }
      ]);
    }
  });

  it('returns only outputs and preserves explicit empty outputs over legacy fields', () => {
    expect(publicResult(normalizeCellExecutionResult({ stdout: 'ignored', value: 1, outputs: [] }))).toEqual({
      outputs: []
    });
    const outputs = [
      { kind: 'text', stream: 'stdout', content: 'first' },
      { kind: 'text', stream: 'stderr', content: 'warning' },
      { kind: 'json', value: null },
      { kind: 'json', value: false },
      { kind: 'json', value: 0 },
      { kind: 'json', value: '' }
    ];
    expect(publicResult(normalizeCellExecutionResult({ outputs }))).toEqual({ outputs });
  });

  it('keeps validation failures scoped and never exposes invalid artifacts as normalized outputs', () => {
    const result = normalizeCellExecutionResult({
      stdout: 'must not replace explicit outputs',
      outputs: [
        { kind: 'chart', spec: { kind: 'line', series: [{ points: [[0, Number.NaN]] }] } },
        { kind: 'text', stream: 'display', content: 'still usable' }
      ]
    });

    expect(result.outputs).toEqual([{ kind: 'text', stream: 'display', content: 'still usable' }]);
    expect(result.outputResults).toMatchObject([
      { status: 'error', index: 0 },
      { status: 'valid', index: 1, artifact: { content: 'still usable' } }
    ]);
  });

  it('validates supported artifact shapes', () => {
    expect(isOutputArtifact({ kind: 'text', stream: 'display', content: 'hello' })).toBe(true);
    expect(isOutputArtifact({ kind: 'json', value: null })).toBe(true);
    expect(
      isOutputArtifact({
        kind: 'table',
        columns: [{ key: 'count', label: 'Count', type: 'integer' }],
        rows: [[1]],
        rowCount: 1
      })
    ).toBe(true);
    expect(isOutputArtifact({ kind: 'chart', spec: { kind: 'scatter', series: [] } })).toBe(true);
    expect(isOutputArtifact({ kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' })).toBe(true);
    expect(isOutputArtifact({ kind: 'html', html: '<strong>x</strong>', sandboxed: true })).toBe(true);

    expect(isOutputArtifact({ kind: 'text', stream: 'debug', content: 'hello' })).toBe(false);
    expect(isOutputArtifact({ kind: 'json' })).toBe(false);
    expect(isOutputArtifact({ kind: 'table', columns: [{ key: 'x', label: 'x', type: 'wide' }], rows: [] })).toBe(
      false
    );
    expect(isOutputArtifact({ kind: 'chart', spec: { kind: 'pie' } })).toBe(false);
    expect(isOutputArtifact({ kind: 'image', mime: 'image/gif', data: '' })).toBe(false);
    expect(isOutputArtifact({ kind: 'html', html: '<script></script>', sandboxed: false })).toBe(false);
    expect(isOutputArtifact({ kind: 'missing' })).toBe(false);
  });
});
