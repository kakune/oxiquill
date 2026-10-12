import { describe, expect, it } from 'vitest';
import { createHaskellOutputCapture } from '../../packages/oxiquill/src/lib/doc-runtime/haskell-output';
import { outputArtifactLimits } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';

const encoder = new TextEncoder();
const json = { kind: 'json', value: { text: '\u65e5\u672c\ud83c\udf0d', controls: '\n\t"\\\x1e' } };
const frame = (value: unknown) => {
  const payload = JSON.stringify(value);
  return `\x1eOXIQUILL/1 ${encoder.encode(payload).length}\n${payload}\x1f`;
};

describe('Haskell output framing', () => {
  it.each([1, 2, 7, 1000])('preserves text, UTF-8, and artifact order in chunks of %s bytes', (size) => {
    const capture = createHaskellOutputCapture();
    const bytes = encoder.encode(
      `before \u65e5\u672c\n${frame(json)}after\n${frame({ kind: 'table', columns: [], rows: [] })}`
    );
    for (let offset = 0; offset < bytes.length; offset += size)
      capture.writeStdout(bytes.subarray(offset, offset + size));
    capture.writeStderr(encoder.encode('warning'));
    expect(capture.take().outputs).toEqual([
      { kind: 'text', stream: 'stdout', content: 'before \u65e5\u672c' },
      json,
      { kind: 'text', stream: 'stdout', content: 'after' },
      { kind: 'table', columns: [], rows: [] },
      { kind: 'text', stream: 'stderr', content: 'warning' }
    ]);
  });

  it('keeps marker-like text and supports escaped reserved markers', () => {
    const capture = createHaskellOutputCapture();
    const text = 'OXIQUILL/1 10\nordinary\x1eother\x1e\x1eOXIQUILL/1 10\n';
    for (const byte of encoder.encode(text)) capture.writeStdout(new Uint8Array([byte]));
    expect(capture.take().outputs).toEqual([
      { kind: 'text', stream: 'stdout', content: text.replace('\x1e\x1e', '\x1e').trimEnd() }
    ]);
  });

  it.each([
    '\x1eOXIQUILL/2 2\n{}\x1f',
    '\x1eOXIQUILL/1 no\n{}\x1f',
    '\x1eOXIQUILL/1 2\nxx\x1f',
    '\x1eOXIQUILL/1 2\n{}',
    '\x1eOXIQUILL/1 100\n{}\x1f',
    frame({ kind: 'html', html: '<b>Unsupported</b>' })
  ])('isolates malformed frames and recovers subsequent artifacts', (invalid) => {
    const capture = createHaskellOutputCapture();
    capture.writeStdout(encoder.encode(`before${invalid}${frame(json)}after`));
    const outputs = capture.take().outputs;
    expect(outputs[0]).toMatchObject({ kind: 'text', content: 'before' });
    expect(outputs).toContainEqual(expect.objectContaining({ kind: '__oxiquill_error' }));
    expect(outputs).toContainEqual(json);
    expect(outputs.at(-1)).toMatchObject({ kind: 'text', content: 'after' });
  });

  it.each(['\x1eOXIQUILL/', '\x1eOXIQUILL/1 8\n{', '\x1eOXIQUILL/1 2\n{}'])(
    'diagnoses incomplete frames at EOF',
    (source) => {
      const capture = createHaskellOutputCapture();
      capture.writeStdout(encoder.encode(source));
      expect(capture.take().outputs).toContainEqual(
        expect.objectContaining({ kind: '__oxiquill_error', message: expect.stringContaining('Incomplete') })
      );
    }
  );

  it('bounds streams independently while retaining frames after text truncation', () => {
    const capture = createHaskellOutputCapture({ ...outputArtifactLimits, bytesPerStream: 10 });
    capture.writeStdout(encoder.encode(`12345678901${frame(json)}`));
    capture.writeStderr(encoder.encode('12345678901'));
    expect(capture.take().outputs).toEqual([
      { kind: 'text', stream: 'stdout', content: '1234567\u2026', truncated: true },
      json,
      { kind: 'text', stream: 'stderr', content: '1234567\u2026', truncated: true }
    ]);
  });

  it.each([
    [6, '日本', 6, { content: '日本' }],
    [6, '日本語', 9, { content: '日…', truncated: true }],
    [6, '日本', 1, { content: '日本' }],
    [4, '日本', 1, { content: '日', truncated: true }]
  ])('bounds %s UTF-8 bytes of %j written in %s-byte chunks', (bytesPerStream, text, size, expected) => {
    const capture = createHaskellOutputCapture({ ...outputArtifactLimits, bytesPerStream });
    const bytes = encoder.encode(text);
    for (let offset = 0; offset < bytes.length; offset += size)
      capture.writeStdout(bytes.subarray(offset, offset + size));
    expect(capture.take().outputs).toEqual([{ kind: 'text', stream: 'stdout', ...expected }]);
  });

  it('bounds headers, frames, cumulative bytes, and artifact count', () => {
    const capture = createHaskellOutputCapture({ ...outputArtifactLimits, validatedBytesPerRun: 100 });
    capture.writeStdout(encoder.encode(`\x1eOXIQUILL/1 ${'9'.repeat(70)}\n{}\x1f${frame(json)}${frame(json)}`));
    expect(capture.take().outputs).toEqual([
      expect.objectContaining({ kind: '__oxiquill_error' }),
      json,
      expect.objectContaining({ kind: '__oxiquill_error' })
    ]);
    const countCapture = createHaskellOutputCapture({ ...outputArtifactLimits, artifactsPerRun: 2 });
    countCapture.writeStdout(encoder.encode(frame(json).repeat(4)));
    expect(countCapture.take().outputs).toEqual([
      json,
      expect.objectContaining({ kind: '__oxiquill_error', message: expect.stringContaining('count limit') })
    ]);
  });
});
