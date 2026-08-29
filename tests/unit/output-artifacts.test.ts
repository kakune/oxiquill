import { describe, expect, it } from 'vitest';
import {
  isOutputArtifact,
  legacyResultToOutputs,
  type NormalizedCellExecutionResult,
  normalizeCellExecutionResult,
  outputsToLegacyResult
} from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';

function publicResult(result: NormalizedCellExecutionResult) {
  const { outputResults: _outputResults, ...publicFields } = result;
  return publicFields;
}

describe('output artifact normalization', () => {
  it('converts legacy cell fields to ordered output artifacts', () => {
    expect(legacyResultToOutputs({})).toEqual([]);

    const outputs = legacyResultToOutputs({
      stdout: 'printed',
      stderr: 'warned',
      value: { ok: true },
      plots: [{ kind: 'line', x_label: 'n', y_label: 'x', points: [[0, 0.2]] }]
    });

    expect(outputs).toEqual([
      { kind: 'text', stream: 'stdout', content: 'printed' },
      { kind: 'text', stream: 'stderr', content: 'warned' },
      { kind: 'json', value: { ok: true } },
      {
        kind: 'chart',
        spec: {
          kind: 'line',
          xLabel: 'n',
          yLabel: 'x',
          xType: 'value',
          yType: 'value',
          tooltip: true,
          dataZoom: true,
          series: [{ points: [[0, 0.2]] }]
        }
      }
    ]);
  });

  it('derives legacy aliases from output artifacts', () => {
    const result = outputsToLegacyResult([
      { kind: 'text', stream: 'stdout', content: 'first' },
      { kind: 'text', stream: 'stdout', content: 'second' },
      { kind: 'text', stream: 'stderr', content: 'warning' },
      { kind: 'json', value: { answer: 42 } },
      {
        kind: 'chart',
        spec: {
          kind: 'line',
          xLabel: 'x',
          yLabel: 'y',
          series: [{ points: [[1, 2]] }]
        }
      }
    ]);

    expect(result).toMatchObject({
      stdout: 'first\nsecond',
      stderr: 'warning',
      value: { answer: 42 },
      plots: [{ kind: 'line', x_label: 'x', y_label: 'y', points: [[1, 2]] }]
    });

    expect(
      outputsToLegacyResult([
        {
          kind: 'chart',
          spec: {
            kind: 'line',
            series: [{ points: [[1, 'not numeric']] }]
          }
        }
      ])
    ).toMatchObject({ plots: [] });

    expect(
      outputsToLegacyResult([
        {
          kind: 'chart',
          spec: {
            kind: 'line',
            series: [{ points: [[1, 2]] }]
          }
        }
      ])
    ).toMatchObject({ plots: [{ kind: 'line', x_label: '', y_label: '', points: [[1, 2]] }] });
  });

  it('normalizes legacy-only and outputs-only worker results', () => {
    expect(publicResult(normalizeCellExecutionResult({ stdout: 'old', plots: [] }))).toEqual({
      stdout: 'old',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stdout', content: 'old' }]
    });

    expect(
      publicResult(
        normalizeCellExecutionResult({
          outputs: [{ kind: 'json', value: ['new'] }]
        })
      )
    ).toEqual({
      stdout: '',
      value: ['new'],
      plots: [],
      outputs: [{ kind: 'json', value: ['new'] }]
    });

    expect(
      publicResult(
        normalizeCellExecutionResult({
          outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
        })
      )
    ).toEqual({
      stdout: '',
      stderr: 'from outputs',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
    });

    expect(
      publicResult(
        normalizeCellExecutionResult({
          stderr: 'explicit',
          outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
        })
      )
    ).toEqual({
      stdout: '',
      stderr: 'explicit',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
    });
  });

  it('keeps explicit legacy aliases when outputs are already present', () => {
    expect(
      publicResult(
        normalizeCellExecutionResult({
          stdout: 'alias',
          value: null,
          plots: [{ kind: 'line', x_label: 'old-x', y_label: 'old-y', points: [[0, 0]] }],
          outputs: [{ kind: 'json', value: { from: 'outputs' } }]
        })
      )
    ).toEqual({
      stdout: 'alias',
      value: null,
      plots: [{ kind: 'line', x_label: 'old-x', y_label: 'old-y', points: [[0, 0]] }],
      outputs: [{ kind: 'json', value: { from: 'outputs' } }]
    });
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
