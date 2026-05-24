import { describe, expect, it } from 'vitest';
import {
  defaultOutputLimits,
  isOutputArtifact,
  legacyResultToOutputs,
  normalizeCellExecutionResult,
  outputsToLegacyResult,
  withDefaultOutputLimits
} from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';

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

    expect(outputsToLegacyResult([
      {
        kind: 'chart',
        spec: {
          kind: 'line',
          series: [{ points: [[1, 'not numeric']] }]
        }
      }
    ])).toMatchObject({ plots: [] });

    expect(outputsToLegacyResult([
      {
        kind: 'chart',
        spec: {
          kind: 'line',
          series: [{ points: [[1, 2]] }]
        }
      }
    ])).toMatchObject({ plots: [{ kind: 'line', x_label: '', y_label: '', points: [[1, 2]] }] });
  });

  it('normalizes legacy-only and outputs-only worker results', () => {
    expect(normalizeCellExecutionResult({ stdout: 'old', plots: [] })).toEqual({
      stdout: 'old',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stdout', content: 'old' }]
    });

    expect(
      normalizeCellExecutionResult({
        outputs: [{ kind: 'json', value: ['new'] }]
      })
    ).toEqual({
      stdout: '',
      value: ['new'],
      plots: [],
      outputs: [{ kind: 'json', value: ['new'] }]
    });

    expect(
      normalizeCellExecutionResult({
        outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
      })
    ).toEqual({
      stdout: '',
      stderr: 'from outputs',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
    });

    expect(
      normalizeCellExecutionResult({
        stderr: 'explicit',
        outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
      })
    ).toEqual({
      stdout: '',
      stderr: 'explicit',
      plots: [],
      outputs: [{ kind: 'text', stream: 'stderr', content: 'from outputs' }]
    });
  });

  it('keeps explicit legacy aliases when outputs are already present', () => {
    expect(
      normalizeCellExecutionResult({
        stdout: 'alias',
        value: null,
        plots: [{ kind: 'line', x_label: 'old-x', y_label: 'old-y', points: [[0, 0]] }],
        outputs: [{ kind: 'json', value: { from: 'outputs' } }]
      })
    ).toEqual({
      stdout: 'alias',
      value: null,
      plots: [{ kind: 'line', x_label: 'old-x', y_label: 'old-y', points: [[0, 0]] }],
      outputs: [{ kind: 'json', value: { from: 'outputs' } }]
    });
  });

  it('validates supported artifact shapes', () => {
    expect(isOutputArtifact({ kind: 'text', stream: 'display', content: 'hello' })).toBe(true);
    expect(isOutputArtifact({ kind: 'json', value: null })).toBe(true);
    expect(isOutputArtifact({
      kind: 'table',
      columns: [{ key: 'count', label: 'Count', type: 'integer' }],
      rows: [[1]],
      rowCount: 1
    })).toBe(true);
    expect(isOutputArtifact({ kind: 'chart', spec: { kind: 'scatter', series: [] } })).toBe(true);
    expect(isOutputArtifact({ kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' })).toBe(true);
    expect(isOutputArtifact({ kind: 'html', html: '<strong>x</strong>', sandboxed: true })).toBe(true);

    expect(isOutputArtifact({ kind: 'text', stream: 'debug', content: 'hello' })).toBe(false);
    expect(isOutputArtifact({ kind: 'json' })).toBe(false);
    expect(isOutputArtifact({ kind: 'table', columns: [{ key: 'x', label: 'x', type: 'wide' }], rows: [] })).toBe(false);
    expect(isOutputArtifact({ kind: 'chart', spec: { kind: 'pie' } })).toBe(false);
    expect(isOutputArtifact({ kind: 'image', mime: 'image/gif', data: '' })).toBe(false);
    expect(isOutputArtifact({ kind: 'html', html: '<script></script>', sandboxed: false })).toBe(false);
    expect(isOutputArtifact({ kind: 'missing' })).toBe(false);
  });

  it('exposes overridable default output limits', () => {
    expect(defaultOutputLimits).toEqual({
      maxTextBytes: 200_000,
      maxJsonBytes: 500_000,
      maxJsonDepth: 32,
      maxTableRows: 1_000,
      maxImageBytes: 2_000_000,
      maxHtmlBytes: 500_000
    });
    expect(withDefaultOutputLimits({ maxTableRows: 10 })).toEqual({
      ...defaultOutputLimits,
      maxTableRows: 10
    });
  });
});
