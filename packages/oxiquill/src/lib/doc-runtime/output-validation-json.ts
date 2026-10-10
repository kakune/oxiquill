import { outputArtifactLimits, truncateUtf8, utf8ByteLength } from './output-limits.mjs';
import type { ValidationSuccess } from './output-validation-common.js';
import {
  ArtifactValidationError,
  contentByteBudget,
  plainRecord,
  plainArray,
  dataDescriptor,
  requiredOwnValue,
  optionalBoolean,
  validateBaseArtifact,
  artifactMetadata
} from './output-validation-common.js';

type JsonFormatResult = {
  formatted: string;
  safeValue: unknown;
  truncated: boolean;
};

type JsonVisitTask = {
  assign: (value: unknown) => void;
  depth: number;
  input: unknown;
  kind: 'visit';
  path: string;
};

type JsonArrayTask = {
  depth: number;
  index: number;
  input: unknown[];
  kind: 'array';
  output: unknown[];
  path: string;
};

type JsonObjectTask = {
  depth: number;
  index: number;
  input: Record<string, unknown>;
  keys: string[];
  kind: 'object';
  output: Record<string, unknown>;
  path: string;
};

type JsonTask = JsonVisitTask | JsonArrayTask | JsonObjectTask;

const maximumJsonNestingDepth = 100;

export function validateJsonArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  const base = validateBaseArtifact(record);
  const value = requiredOwnValue(record, 'value', 'JSON artifact');
  const producerTruncated = optionalBoolean(record, 'truncated', 'JSON artifact') ?? false;
  const valueBudget = Math.min(
    outputArtifactLimits.bytesPerTextJsonOrHtml,
    contentByteBudget(base.byteLength, remainingBytes)
  );
  const formatted = safeJsonFormat(value, valueBudget, 'JSON artifact value');
  const byteLength = utf8ByteLength(formatted.formatted);

  return {
    artifact: {
      ...artifactMetadata(base),
      kind: 'json',
      value: formatted.safeValue,
      formattedValue: formatted.formatted,
      ...(producerTruncated || formatted.truncated ? { truncated: true } : {})
    },
    byteLength: base.byteLength + byteLength
  };
}

export function safeJsonFormat(value: unknown, maxBytes: number, context: string): JsonFormatResult {
  if (maxBytes <= 0) return { formatted: '', safeValue: null, truncated: true };

  let safeValue: unknown;
  let estimatedBytes = 0;
  let truncated = false;
  const active = new WeakMap<object, string>();
  const tasks: JsonTask[] = [
    {
      kind: 'visit',
      input: value,
      path: '$',
      depth: 0,
      assign: (next) => {
        safeValue = next;
      }
    }
  ];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task == null) break;
    if (task.kind === 'array') {
      if (estimatedBytes >= maxBytes) {
        task.output.push('[Truncated]');
        active.delete(task.input);
        truncated = true;
        continue;
      }
      if (task.index >= task.input.length) {
        active.delete(task.input);
        continue;
      }
      if (!Object.hasOwn(task.input, task.index)) {
        throw new ArtifactValidationError(`${context} contains a sparse array at ${task.path}.`);
      }
      tasks.push({ ...task, index: task.index + 1 });
      const descriptor = dataDescriptor(task.input, task.index, `${context} at ${task.path}`);
      tasks.push({
        kind: 'visit',
        input: descriptor.value,
        path: `${task.path}[${task.index}]`,
        depth: task.depth + 1,
        assign: (next) => {
          task.output[task.index] = next;
        }
      });
      continue;
    }
    if (task.kind === 'object') {
      if (estimatedBytes >= maxBytes) {
        active.delete(task.input);
        truncated = true;
        continue;
      }
      if (task.index >= task.keys.length) {
        active.delete(task.input);
        continue;
      }
      const key = task.keys[task.index];
      if (key == null) continue;
      const descriptor = dataDescriptor(task.input, key, `${context} at ${task.path}`);
      estimatedBytes += utf8ByteLength(key) + 4;
      tasks.push({ ...task, index: task.index + 1 });
      tasks.push({
        kind: 'visit',
        input: descriptor.value,
        path: jsonObjectPath(task.path, key),
        depth: task.depth + 1,
        assign: (next) => {
          Object.defineProperty(task.output, key, {
            configurable: true,
            enumerable: true,
            value: next,
            writable: true
          });
        }
      });
      continue;
    }

    if (estimatedBytes >= maxBytes) {
      task.assign('[Truncated]');
      truncated = true;
      continue;
    }
    if (task.depth > maximumJsonNestingDepth) {
      task.assign('[Truncated]');
      truncated = true;
      continue;
    }

    const input = task.input;
    if (input === null) {
      estimatedBytes += 4;
      task.assign(null);
    } else if (typeof input === 'string') {
      const bounded = truncateUtf8(input, Math.max(0, maxBytes - estimatedBytes));
      estimatedBytes += bounded.byteLength + 2;
      truncated ||= bounded.truncated;
      task.assign(bounded.value);
    } else if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new ArtifactValidationError(`${context} contains a non-finite number at ${task.path}.`);
      }
      estimatedBytes += String(input).length;
      task.assign(input);
    } else if (typeof input === 'boolean') {
      estimatedBytes += input ? 4 : 5;
      task.assign(input);
    } else if (typeof input === 'bigint') {
      const digits = input.toString();
      estimatedBytes += utf8ByteLength(digits) + 16;
      task.assign({ $bigint: digits });
    } else if (typeof input === 'object') {
      const existingPath = active.get(input);
      if (existingPath) {
        const marker = `[Circular -> ${existingPath}]`;
        estimatedBytes += utf8ByteLength(marker) + 2;
        task.assign(marker);
        continue;
      }
      if (Array.isArray(input)) {
        const array = plainArray(input, `${context} at ${task.path}`);
        const output: unknown[] = [];
        estimatedBytes += 2;
        task.assign(output);
        active.set(array, task.path);
        tasks.push({ kind: 'array', input: array, output, path: task.path, depth: task.depth, index: 0 });
      } else {
        const record = plainRecord(input, `${context} at ${task.path}`);
        if (Object.getOwnPropertySymbols(record).length > 0) {
          throw new ArtifactValidationError(`${context} contains symbol keys at ${task.path}.`);
        }
        const output = Object.create(null) as Record<string, unknown>;
        estimatedBytes += 2;
        task.assign(output);
        active.set(record, task.path);
        tasks.push({
          kind: 'object',
          input: record,
          output,
          keys: Object.keys(record),
          path: task.path,
          depth: task.depth,
          index: 0
        });
      }
    } else {
      throw new ArtifactValidationError(`${context} contains unsupported ${typeof input} data at ${task.path}.`);
    }
  }

  const serialized = JSON.stringify(safeValue, null, 2) ?? 'null';
  const bounded = truncateUtf8(serialized, maxBytes);
  return {
    formatted: bounded.value,
    safeValue,
    truncated: truncated || bounded.truncated
  };
}

function jsonObjectPath(path: string, key: string): string {
  return truncateUtf8(`${path}.${key}`, outputArtifactLimits.bytesPerDiagnostic / 2).value;
}
