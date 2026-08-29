import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  outputArtifactLimits,
  validateOutputArtifacts,
  type ValidatedOutputArtifact
} from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';

const pngBase64 = 'iVBORw0KGgo=';
const jpegBase64 = '/9j/';

function validArtifact(value: unknown): ValidatedOutputArtifact {
  const result = validateOutputArtifacts([value])[0];
  expect(result?.status).toBe('valid');
  if (!result || result.status !== 'valid') throw new Error('Expected a valid artifact.');
  return result.artifact;
}

function validationError(value: unknown): string {
  const result = validateOutputArtifacts([value])[0];
  expect(result?.status).toBe('error');
  if (!result || result.status !== 'error') throw new Error('Expected an artifact validation error.');
  return result.message;
}

describe('output artifact validation', () => {
  it('validates every public artifact kind and copies supported metadata', () => {
    expect(validArtifact({
      id: 'text-one',
      title: 'Title',
      caption: 'Caption',
      kind: 'text',
      stream: 'display',
      content: 'hello'
    })).toMatchObject({ kind: 'text', id: 'text-one', content: 'hello' });

    expect(validArtifact({ kind: 'json', value: { ok: true } })).toMatchObject({
      kind: 'json',
      formattedValue: '{\n  "ok": true\n}'
    });
    expect(validArtifact({
      kind: 'table',
      columns: [{ key: 'value', label: 'Value', type: 'integer' }],
      rows: [[1]],
      rowCount: 1
    })).toMatchObject({ kind: 'table', rows: [[1]], rowCount: 1 });
    expect(validArtifact({ kind: 'chart', spec: { kind: 'line', series: [] } })).toMatchObject({
      kind: 'chart',
      spec: { kind: 'line', series: [] }
    });
    expect(validArtifact({ kind: 'image', mime: 'image/png', data: pngBase64, alt: 'plot' })).toMatchObject({
      kind: 'image',
      source: `data:image/png;base64,${pngBase64}`
    });
    expect(validArtifact({ kind: 'html', html: '<strong>safe</strong>', sandboxed: true })).toMatchObject({
      kind: 'html',
      sandboxed: true
    });
  });

  it('rejects malformed artifact records, metadata, discriminators, and accessors', () => {
    expect(validationError(null)).toContain('plain record');
    expect(validationError(Object.assign(Object.create({ unsafe: true }), { kind: 'json', value: null })))
      .toContain('custom prototype');
    expect(validationError({ kind: 'missing' })).toContain('Unsupported artifact kind');
    expect(validationError({ kind: 'text', stream: 'debug', content: 'x' })).toContain('stream');
    expect(validationError({ kind: 'text', stream: 'stdout', content: 1 })).toContain('content');
    expect(validationError({ kind: 'json' })).toContain('own data property');
    expect(validationError({ kind: 'html', html: '', sandboxed: false })).toContain('sandboxed');
    expect(validationError({ kind: 'chart', truncated: false, spec: { kind: 'line', series: [] } }))
      .toContain('does not support');

    const accessor = { kind: 'text', stream: 'stdout' } as Record<string, unknown>;
    Object.defineProperty(accessor, 'content', { enumerable: true, get: () => 'unsafe' });
    expect(validationError(accessor)).toContain('own data property');
    expect(validationError({ kind: 'text', stream: 'stdout', content: 'x', title: 1 }))
      .toContain('when provided');
  });

  it('accepts exact text and HTML limits, truncates text, and rejects oversized HTML', () => {
    const exact = 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml);
    const text = validArtifact({ kind: 'text', stream: 'stdout', content: exact });
    expect(text).toMatchObject({ kind: 'text', content: exact });
    expect(text).not.toHaveProperty('truncated');

    const oversizedText = validArtifact({ kind: 'text', stream: 'stdout', content: `${exact}x` });
    expect(oversizedText).toMatchObject({ kind: 'text', truncated: true });
    if (oversizedText.kind === 'text') {
      expect(new TextEncoder().encode(oversizedText.content).byteLength)
        .toBeLessThanOrEqual(outputArtifactLimits.bytesPerTextJsonOrHtml);
      expect(oversizedText.content.endsWith('…')).toBe(true);
    }

    expect(validArtifact({ kind: 'html', html: exact, sandboxed: true })).toMatchObject({ kind: 'html' });
    expect(validationError({ kind: 'html', html: `${exact}x`, sandboxed: true })).toContain('maximum');
  });

  it('formats cyclic JSON and BigInt explicitly without invoking unsafe JSON operations', () => {
    const value: Record<string, unknown> = { integer: 123n };
    value.self = value;
    const artifact = validArtifact({ kind: 'json', value });
    expect(artifact).toMatchObject({ kind: 'json' });
    if (artifact.kind === 'json') {
      expect(artifact.formattedValue).toContain('"$bigint": "123"');
      expect(artifact.formattedValue).toContain('[Circular -> $]');
    }

    expect(validationError({ kind: 'json', value: Number.NaN })).toContain('non-finite');
    expect(validationError({ kind: 'json', value: Symbol('unsafe') })).toContain('unsupported symbol');
    expect(validationError({ kind: 'json', value: Object.assign(Object.create({}), { key: 'value' }) }))
      .toContain('custom prototype');

    const sparse = new Array(2);
    sparse[0] = 'present';
    expect(validationError({ kind: 'json', value: sparse })).toContain('sparse');

    const symbolKey = { visible: true } as Record<PropertyKey, unknown>;
    symbolKey[Symbol('hidden')] = true;
    expect(validationError({ kind: 'json', value: symbolKey })).toContain('symbol keys');
  });

  it('bounds deeply nested and oversized JSON while preserving a scoped result', () => {
    const root: Record<string, unknown> = {};
    let current = root;
    for (let index = 0; index < 2_000; index += 1) {
      const next: Record<string, unknown> = {};
      current.next = next;
      current = next;
    }
    current.payload = 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml);

    const artifact = validArtifact({ kind: 'json', value: root });
    expect(artifact).toMatchObject({ kind: 'json', truncated: true });
    if (artifact.kind === 'json') {
      expect(new TextEncoder().encode(artifact.formattedValue).byteLength)
        .toBeLessThanOrEqual(outputArtifactLimits.bytesPerTextJsonOrHtml);
    }
  });

  it('accepts the exact serialized JSON limit and truncates one byte over it', () => {
    const exactValue = 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml - 2);
    const exact = validArtifact({ kind: 'json', value: exactValue });
    expect(exact).not.toHaveProperty('truncated');

    const oversized = validArtifact({ kind: 'json', value: `${exactValue}x` });
    expect(oversized).toMatchObject({ kind: 'json', truncated: true });
  });

  it('validates table shape, safe cells, row counts, and column metadata', () => {
    const cyclic: Record<string, unknown> = { big: 9n };
    cyclic.self = cyclic;
    const artifact = validArtifact({
      kind: 'table',
      columns: [
        { key: 'object', label: 'Object', type: 'unknown' },
        { key: 'missing', label: 'Missing' }
      ],
      rows: [[cyclic, undefined]],
      rowCount: 4,
      truncated: true
    });
    expect(artifact).toMatchObject({ kind: 'table', rowCount: 4, truncated: true });
    if (artifact.kind === 'table') {
      expect(artifact.rows[0]?.[0]).toContain('"$bigint": "9"');
      expect(artifact.rows[0]?.[1]).toBeNull();
    }

    expect(validationError({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }],
      rows: [[]]
    })).toContain('expected 1');
    expect(validationError({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }, { key: 'x', label: 'Duplicate' }],
      rows: [[1, 2]]
    })).toContain('unique');
    expect(validationError({
      kind: 'table',
      columns: [{ key: 'x', label: 'X', type: 'wide' }],
      rows: [[1]]
    })).toContain('not supported');
    expect(validationError({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }],
      rows: [[1]],
      rowCount: 0
    })).toContain('smaller');
    expect(validationError({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }],
      rows: [[Number.POSITIVE_INFINITY]]
    })).toContain('finite');
  });

  it('truncates tables at the row and column boundaries', () => {
    const exactRows = validArtifact({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }],
      rows: Array.from({ length: outputArtifactLimits.rowsPerTable }, (_, index) => [index])
    });
    expect(exactRows).not.toHaveProperty('truncated');

    const rowLimited = validArtifact({
      kind: 'table',
      columns: [{ key: 'x', label: 'X' }],
      rows: Array.from({ length: outputArtifactLimits.rowsPerTable + 1 }, (_, index) => [index])
    });
    expect(rowLimited).toMatchObject({ kind: 'table', truncated: true });
    if (rowLimited.kind === 'table') expect(rowLimited.rows).toHaveLength(outputArtifactLimits.rowsPerTable);

    const columns = Array.from(
      { length: outputArtifactLimits.columnsPerTable + 1 },
      (_, index) => ({ key: String(index), label: String(index) })
    );
    const columnLimited = validArtifact({
      kind: 'table',
      columns,
      rows: [columns.map((_, index) => index)]
    });
    expect(columnLimited).toMatchObject({ kind: 'table', truncated: true });
    if (columnLimited.kind === 'table') {
      expect(columnLimited.columns).toHaveLength(outputArtifactLimits.columnsPerTable);
      expect(columnLimited.rows[0]).toHaveLength(outputArtifactLimits.columnsPerTable);
    }
  });

  it.each([
    { kind: 'line', series: [{ name: 'line', points: [[0, 1]] }] },
    { kind: 'scatter', series: [{ points: [['x', 1]] }] },
    { kind: 'area', series: [{ points: [[0, 'y']] }] },
    { kind: 'bar', categories: ['a'], series: [{ name: 'bar', values: [1] }] },
    { kind: 'histogram', bins: [[0, 1, 2]] },
    { kind: 'heatmap', xCategories: ['x'], yCategories: ['y'], data: [['x', 'y', 3]] }
  ])('validates the $kind chart variant', (spec) => {
    expect(validArtifact({
      kind: 'chart',
      spec: {
        title: 'Chart',
        xLabel: 'x',
        yLabel: 'y',
        xType: 'value',
        yType: 'log',
        legend: true,
        tooltip: false,
        dataZoom: true,
        ...spec
      }
    })).toMatchObject({ kind: 'chart', spec: { kind: spec.kind } });
  });

  it('rejects malformed and excessive chart data', () => {
    expect(validationError({ kind: 'chart', spec: { kind: 'pie' } })).toContain('not supported');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'line', xType: 'ordinal', series: [] }
    })).toContain('xType');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'line', series: [{ points: [[0]] }] }
    })).toContain('exactly 2');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'scatter', series: [{ points: [[0, Number.NaN]] }] }
    })).toContain('finite');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'bar', categories: ['a', 'b'], series: [{ values: [1] }] }
    })).toContain('expected 2');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'histogram', bins: [[0, 1, Number.POSITIVE_INFINITY]] }
    })).toContain('finite');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'heatmap', data: [[0, 0, 'hot']] }
    })).toContain('finite');
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'area', series: [{ points: 'not-an-array' }] }
    })).toContain('array');

    const points = Array.from(
      { length: outputArtifactLimits.chartDataItems + 1 },
      (_, index) => [index, index] as const
    );
    expect(validationError({
      kind: 'chart',
      spec: { kind: 'line', series: [{ points }] }
    })).toContain('maximum');
  });

  it.each(['line', 'scatter', 'area'] as const)(
    'accepts the exact %s chart point limit and rejects one point over it',
    (kind) => {
      const points = Array.from(
        { length: outputArtifactLimits.chartDataItems },
        (_, index) => [index, index] as const
      );
      expect(validArtifact({ kind: 'chart', spec: { kind, series: [{ points }] } }))
        .toMatchObject({ kind: 'chart' });
      expect(validationError({
        kind: 'chart',
        spec: { kind, series: [{ points: [...points, [0, 0]] }] }
      })).toContain('maximum');
    }
  );

  it.each([
    {
      kind: 'bar',
      exact: () => ({
        kind: 'bar',
        categories: Array.from({ length: outputArtifactLimits.chartDataItems }, () => 'x'),
        series: [{ values: Array.from({ length: outputArtifactLimits.chartDataItems }, () => 1) }]
      }),
      excessive: () => ({
        kind: 'bar',
        categories: Array.from({ length: outputArtifactLimits.chartDataItems + 1 }, () => 'x'),
        series: []
      })
    },
    {
      kind: 'histogram',
      exact: () => ({
        kind: 'histogram',
        bins: Array.from({ length: outputArtifactLimits.chartDataItems }, () => [0, 1, 1])
      }),
      excessive: () => ({
        kind: 'histogram',
        bins: Array.from({ length: outputArtifactLimits.chartDataItems + 1 }, () => [0, 1, 1])
      })
    },
    {
      kind: 'heatmap',
      exact: () => ({
        kind: 'heatmap',
        data: Array.from({ length: outputArtifactLimits.chartDataItems }, () => [0, 0, 1])
      }),
      excessive: () => ({
        kind: 'heatmap',
        data: Array.from({ length: outputArtifactLimits.chartDataItems + 1 }, () => [0, 0, 1])
      })
    }
  ])('accepts the exact $kind data limit and rejects one item over it', ({ exact, excessive }) => {
    expect(validArtifact({ kind: 'chart', spec: exact() })).toMatchObject({ kind: 'chart' });
    expect(validationError({ kind: 'chart', spec: excessive() })).toContain('maximum');
  });

  it('validates image encodings, MIME declarations, signatures, and SVG payloads', () => {
    expect(validArtifact({ kind: 'image', mime: 'image/jpeg', data: jpegBase64 })).toMatchObject({
      kind: 'image',
      source: `data:image/jpeg;base64,${jpegBase64}`
    });
    expect(validArtifact({
      kind: 'image',
      mime: 'image/svg+xml',
      data: 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E'
    })).toMatchObject({ kind: 'image', data: '<svg></svg>' });
    expect(validArtifact({
      kind: 'image',
      mime: 'image/svg+xml',
      data: '<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg></svg>'
    })).toMatchObject({ kind: 'image' });
    expect(validationError({ kind: 'image', mime: 'image/gif', data: '' })).toContain('not supported');
    expect(validationError({ kind: 'image', mime: 'image/png', data: 'abc' })).toContain('base64');
    expect(validationError({ kind: 'image', mime: 'image/png', data: jpegBase64 })).toContain('does not match');
    expect(validationError({
      kind: 'image',
      mime: 'image/png',
      data: `data:image/jpeg;base64,${jpegBase64}`
    })).toContain('MIME mismatch');
    expect(validationError({ kind: 'image', mime: 'image/svg+xml', data: '<div></div>' })).toContain('<svg>');
    expect(validationError({
      kind: 'image',
      mime: 'image/svg+xml',
      data: 'data:image/svg+xml,%not-encoded'
    })).toContain('percent encoding');
    expect(validationError({
      kind: 'image',
      mime: 'image/png',
      data: 'data:image/png,plain'
    })).toContain('base64 encoding');
    expect(validationError({
      kind: 'image',
      mime: 'image/svg+xml',
      data: `data:image/svg+xml;base64,${Buffer.from([0xff]).toString('base64')}`
    })).toContain('valid UTF-8');
  });

  it('accepts the exact decoded image limit and rejects one byte over it', () => {
    const exact = Buffer.alloc(outputArtifactLimits.decodedBytesPerImage);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(exact);
    expect(validArtifact({ kind: 'image', mime: 'image/png', data: exact.toString('base64') }))
      .toMatchObject({ kind: 'image' });

    const oversized = Buffer.alloc(outputArtifactLimits.decodedBytesPerImage + 1);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversized);
    expect(validationError({ kind: 'image', mime: 'image/png', data: oversized.toString('base64') }))
      .toContain('maximum');
  });

  it('enforces per-run artifact and validated-byte limits without hiding valid siblings', () => {
    const artifactLimit = validateOutputArtifacts(
      Array.from(
        { length: outputArtifactLimits.artifactsPerRun + 1 },
        () => ({ kind: 'text', stream: 'stdout', content: 'x' })
      )
    );
    expect(artifactLimit).toHaveLength(outputArtifactLimits.artifactsPerRun + 1);
    expect(artifactLimit.at(-1)).toMatchObject({ status: 'error', index: outputArtifactLimits.artifactsPerRun });

    const oneMiB = 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml);
    const runLimited = validateOutputArtifacts([
      ...Array.from({ length: 16 }, () => ({ kind: 'text', stream: 'stdout', content: oneMiB })),
      { kind: 'chart', spec: { kind: 'line', series: [] } },
      { kind: 'text', stream: 'stdout', content: 'later' }
    ]);
    expect(runLimited[16]).toMatchObject({ status: 'error' });
    expect(runLimited[17]).toMatchObject({ status: 'valid', artifact: { kind: 'text', truncated: true } });

    const siblings = validateOutputArtifacts([
      { kind: 'chart', spec: { kind: 'line', series: [{ points: [[0, Number.NaN]] }] } },
      { kind: 'text', stream: 'stdout', content: 'still usable' }
    ]);
    expect(siblings[0]).toMatchObject({ status: 'error' });
    expect(siblings[1]).toMatchObject({ status: 'valid', artifact: { content: 'still usable' } });
  });
});
