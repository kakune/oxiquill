import { outputArtifactLimits, truncateUtf8 } from './output-limits.mjs';
import type { RawCellExecutionResult, TextArtifact } from './types.js';

const recordSeparator = 0x1e;
const unitSeparator = 0x1f;
const magic = 'OXIQUILL/';
const encoder = new TextEncoder();

/** Decodes stdout frames without allowing their bytes to consume the text budget. */
export function createHaskellOutputCapture(
  limits: {
    artifactsPerRun: number;
    bytesPerStream: number;
    workerResponseBytes: number;
    validatedBytesPerRun: number;
  } = outputArtifactLimits
) {
  const outputs: (Record<string, unknown> | TextArtifact)[] = [];
  const streams = {
    stdout: { decoder: new TextDecoder(), bytes: 0, truncated: false, last: undefined as TextArtifact | undefined },
    stderr: { decoder: new TextDecoder(), bytes: 0, truncated: false, last: undefined as TextArtifact | undefined }
  };
  let mode: 'text' | 'header' | 'payload' | 'end' | 'discard' = 'text';
  let header = '';
  let payload: Uint8Array | undefined;
  let offset = 0;
  let artifactBytes = 0;
  let countExceeded = false;

  function append(output: Record<string, unknown> | TextArtifact): void {
    if (outputs.length < limits.artifactsPerRun) outputs.push(output);
    else if (!countExceeded) {
      countExceeded = true;
      outputs[outputs.length - 1] = {
        kind: '__oxiquill_error',
        message: 'Haskell output exceeded the artifact count limit.'
      };
    }
  }

  function diagnostic(message: string): void {
    append({ kind: '__oxiquill_error', message });
  }

  function text(stream: 'stdout' | 'stderr', bytes?: Uint8Array): void {
    const state = streams[stream];
    if (state.truncated) return;
    const decoded = bytes ? state.decoder.decode(bytes, { stream: true }) : state.decoder.decode();
    const bounded = truncateUtf8(decoded, Math.max(0, limits.bytesPerStream - state.bytes));
    state.bytes += bounded.byteLength;
    state.truncated = bounded.truncated;
    if (bounded.value) {
      if (outputs.at(-1) === state.last && state.last) state.last.content += bounded.value;
      else {
        state.last = { kind: 'text', stream, content: bounded.value };
        append(state.last);
      }
    }
    if (state.truncated && state.last) state.last.truncated = true;
  }

  function beginPayload(): void {
    const match = /^OXIQUILL\/(\d+) ([0-9]+)\n$/u.exec(header);
    const length = match ? Number(match[2]) : NaN;
    if (!match || !Number.isSafeInteger(length)) {
      diagnostic('Malformed Haskell output frame header.');
      mode = 'discard';
    } else if (match[1] !== '1') {
      diagnostic(`Unsupported Haskell output frame version: ${match[1]}.`);
      mode = 'discard';
    } else if (length > limits.workerResponseBytes || length > limits.validatedBytesPerRun - artifactBytes) {
      diagnostic('Haskell output frame exceeded the artifact byte limit.');
      mode = 'discard';
    } else {
      artifactBytes += length;
      payload = new Uint8Array(length);
      offset = 0;
      mode = length === 0 ? 'end' : 'payload';
    }
    header = '';
  }

  function finishFrame(): void {
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !('kind' in value) ||
        !['json', 'table', 'chart'].includes(String(value.kind))
      ) {
        throw new Error('Expected a JSON, table, or chart artifact.');
      }
      append(value as Record<string, unknown>);
    } catch {
      diagnostic('Invalid Haskell output frame: expected UTF-8 JSON containing a JSON, table, or chart artifact.');
    }
    payload = undefined;
    mode = 'text';
  }

  function writeStdout(bytes: Uint8Array): void {
    let cursor = 0;
    while (cursor < bytes.length) {
      if (mode === 'text') {
        const marker = bytes.indexOf(recordSeparator, cursor);
        const end = marker < 0 ? bytes.length : marker;
        text('stdout', bytes.subarray(cursor, end));
        cursor = end;
        if (marker < 0) break;
        mode = 'header';
        header = '';
        cursor += 1;
      } else if (mode === 'header') {
        const byte = bytes[cursor++];
        if (header === '' && byte === recordSeparator) {
          text('stdout', new Uint8Array([recordSeparator]));
          mode = 'text';
          continue;
        }
        header += String.fromCharCode(byte);
        if (header.length <= magic.length && !magic.startsWith(header)) {
          text(
            'stdout',
            new Uint8Array([recordSeparator, ...Array.from(header, (character) => character.charCodeAt(0))])
          );
          header = '';
          mode = 'text';
        } else if (byte === 10 || header.length > 64) {
          text('stdout');
          beginPayload();
        }
      } else if (mode === 'payload' && payload) {
        const remaining = Math.min(payload.length - offset, bytes.length - cursor);
        const chunk = bytes.subarray(cursor, cursor + remaining);
        const marker = chunk.indexOf(recordSeparator);
        const end = chunk.indexOf(unitSeparator);
        if (marker >= 0 || end >= 0) {
          diagnostic('Incomplete Haskell output frame payload.');
          payload = undefined;
          const boundary = marker < 0 ? end : end < 0 ? marker : Math.min(marker, end);
          cursor += boundary;
          mode = 'discard';
          continue;
        }
        payload.set(chunk, offset);
        offset += remaining;
        cursor += remaining;
        if (offset === payload.length) mode = 'end';
      } else if (mode === 'end') {
        if (bytes[cursor] === unitSeparator) {
          cursor += 1;
          finishFrame();
        } else {
          diagnostic('Haskell output frame is missing its terminator.');
          payload = undefined;
          mode = 'text';
        }
      } else {
        const byte = bytes[cursor++];
        if (byte === unitSeparator) mode = 'text';
        else if (byte === recordSeparator) {
          mode = 'header';
          header = '';
        }
      }
    }
  }

  return {
    writeStdout,
    writeStderr: (bytes: Uint8Array) => text('stderr', bytes),
    take(): RawCellExecutionResult {
      if (mode === 'header' && header.length < magic.length) text('stdout', encoder.encode(`\x1e${header}`));
      else if (mode !== 'text' && mode !== 'discard')
        diagnostic('Incomplete Haskell output frame at end of execution.');
      text('stdout');
      text('stderr');
      return {
        outputs: outputs.map((output) =>
          output.kind === 'text' ? { ...output, content: String(output.content).trimEnd() } : output
        )
      };
    }
  };
}
