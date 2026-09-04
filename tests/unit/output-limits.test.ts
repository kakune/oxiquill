import { describe, expect, it } from 'vitest';
import {
  boundedErrorMessage,
  createBoundedTextAccumulator,
  outputArtifactLimits,
  truncateUtf8,
  utf8ByteLength
} from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';
import { boundWorkerResult, workerResultByteLength } from '../../packages/oxiquill/src/lib/doc-runtime/worker-output';

describe('producer output limits', () => {
  it('retains exact UTF-8 stream limits and marks over-limit output without retaining later chunks', () => {
    const exact = createBoundedTextAccumulator(8, '\n');
    exact.append('abc');
    exact.append('defg');
    expect(exact.take()).toEqual({ value: 'abc\ndefg', truncated: false });

    const oversized = createBoundedTextAccumulator(8, '\n');
    oversized.append('abc');
    oversized.append('defgh');
    oversized.append('discarded');
    expect(oversized.take()).toEqual({ value: 'abc\nd…', truncated: true });
    expect(utf8ByteLength(oversized.take().value)).toBe(8);

    expect(truncateUtf8('日本語', 6)).toEqual({ value: '日…', byteLength: 6, truncated: true });
  });

  it('bounds worker errors by UTF-8 bytes', () => {
    const exact = 'x'.repeat(outputArtifactLimits.bytesPerError);
    expect(boundedErrorMessage(new Error(exact))).toBe(exact);

    const oversized = boundedErrorMessage('界'.repeat(outputArtifactLimits.bytesPerError));
    expect(utf8ByteLength(oversized)).toBeLessThanOrEqual(outputArtifactLimits.bytesPerError);
    expect(oversized.endsWith('…')).toBe(true);
  });

  it('returns a stable bounded fallback for missing and unstringifiable errors', () => {
    const errorWithThrowingMessage = new Error('hidden');
    Object.defineProperty(errorWithThrowingMessage, 'message', {
      get: () => {
        throw new Error('message getter failed');
      }
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    const missingMessages = [
      new Error(),
      new Error('   '),
      '',
      ' \n\t ',
      Object.create(null),
      {
        toString: () => {
          throw new Error('toString failed');
        }
      },
      {
        [Symbol.toPrimitive]: () => {
          throw new Error('primitive conversion failed');
        }
      },
      errorWithThrowingMessage,
      revoked.proxy
    ];

    for (const value of missingMessages) {
      const normalized = boundedErrorMessage(value);
      expect(normalized).toBe('Unknown error.');
      expect(utf8ByteLength(normalized)).toBeLessThanOrEqual(outputArtifactLimits.bytesPerError);
    }
  });

  it('normalizes aliases from bounded outputs and caps complete worker responses', () => {
    const rawAlias = 'x'.repeat(outputArtifactLimits.workerResponseBytes + 1);
    const boundedAlias = boundWorkerResult({
      stdout: rawAlias,
      outputs: [{ kind: 'text', stream: 'stdout', content: 'bounded' }]
    });
    expect(boundedAlias.stdout).toBe('bounded');
    expect(boundedAlias.outputs).toEqual([{ kind: 'text', stream: 'stdout', content: 'bounded' }]);

    const oneMiB = 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml);
    const boundedResponse = boundWorkerResult({
      outputs: Array.from({ length: 20 }, () => ({ kind: 'text', stream: 'display', content: oneMiB }))
    });
    expect(workerResultByteLength(boundedResponse)).toBeLessThanOrEqual(outputArtifactLimits.workerResponseBytes);
    expect(boundedResponse.outputs?.at(-1)).toMatchObject({ kind: '__oxiquill_error' });
  });

  it('keeps valid siblings while replacing invalid producer artifacts with bounded diagnostics', () => {
    const result = boundWorkerResult({
      outputs: [
        { kind: 'x'.repeat(outputArtifactLimits.bytesPerDiagnostic * 2) },
        { kind: 'text', stream: 'stdout', content: 'still usable' }
      ]
    });
    expect(result.outputs?.[0]).toMatchObject({ kind: '__oxiquill_error' });
    expect(utf8ByteLength(String((result.outputs?.[0] as { message?: string }).message))).toBeLessThanOrEqual(
      outputArtifactLimits.bytesPerDiagnostic
    );
    expect(result.outputs?.[1]).toMatchObject({ kind: 'text', content: 'still usable' });
    expect(result.stdout).toBe('still usable');
  });
});
