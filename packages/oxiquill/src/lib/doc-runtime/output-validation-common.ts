import type {
  HtmlArtifact,
  ImageArtifact,
  JsonArtifact,
  OutputArtifact,
  TableArtifact,
  TextArtifact
} from './types.js';
import { outputArtifactLimits, truncateUtf8, utf8ByteLength } from './output-limits.mjs';

export interface ValidatedJsonArtifact extends JsonArtifact {
  formattedValue: string;
}

export interface ValidatedImageArtifact extends ImageArtifact {
  source: string;
}

export type ValidatedOutputArtifact =
  | TextArtifact
  | ValidatedJsonArtifact
  | TableArtifact
  | Extract<OutputArtifact, { kind: 'chart' }>
  | ValidatedImageArtifact
  | HtmlArtifact;

export type ValidatedArtifactResult =
  | {
      status: 'valid';
      artifact: ValidatedOutputArtifact;
      byteLength: number;
      index: number;
    }
  | {
      status: 'error';
      message: string;
      index: number;
    };

export type ValidationSuccess = {
  artifact: ValidatedOutputArtifact;
  byteLength: number;
};

type BaseArtifact = {
  caption?: string;
  id?: string;
  title?: string;
  byteLength: number;
};

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(truncateUtf8(message, outputArtifactLimits.bytesPerDiagnostic).value);
  }
}

export function contentByteBudget(metadataBytes: number, remainingBytes: number): number {
  if (metadataBytes > remainingBytes) {
    throw new ArtifactValidationError('Artifact metadata exceeds the remaining 16 MiB run limit.');
  }
  return remainingBytes - metadataBytes;
}

export function payloadByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

export function plainRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError(`${context} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactValidationError(`${context} must not have a custom prototype.`);
  }
  return value as Record<string, unknown>;
}

export function plainArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new ArtifactValidationError(`${context} must be an array.`);
  }
  const inspectionLimit = Math.min(value.length, outputArtifactLimits.chartDataItems + 1);
  for (let index = 0; index < inspectionLimit; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) throw new ArtifactValidationError(`${context} must not be sparse.`);
    if (!Object.hasOwn(descriptor, 'value')) {
      throw new ArtifactValidationError(`${context} item ${index + 1} must be an own data property.`);
    }
  }
  return value;
}

export function dataDescriptor(
  record: object,
  key: PropertyKey,
  context: string
): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new ArtifactValidationError(`${context} field ${quoted(String(key))} must be an own data property.`);
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

export function requiredOwnValue(record: Record<string, unknown>, key: string, context: string): unknown {
  return dataDescriptor(record, key, context).value;
}

export function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'string') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a string.`);
  }
  return value;
}

export function optionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'string') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a string when provided.`);
  }
  requireMetadataBudget(value, `${context} field ${quoted(key)}`);
  return value;
}

export function optionalBoolean(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'boolean') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a boolean when provided.`);
  }
  return value;
}

export function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  context: string
): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a non-negative safe integer.`);
  }
  return value;
}

export function rejectTruncated(record: Record<string, unknown>, context: string): void {
  if (Object.hasOwn(record, 'truncated')) {
    throw new ArtifactValidationError(`${context} does not support the truncated field.`);
  }
}

export function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArtifactValidationError(`${context} must be a finite number.`);
  }
  return value;
}

export function quoted(value: string): string {
  return JSON.stringify(truncateUtf8(value, 256).value);
}

export function requireMetadataBudget(value: string, context: string): void {
  const byteLength = utf8ByteLength(value);
  if (byteLength > outputArtifactLimits.bytesPerMetadataField) {
    throw new ArtifactValidationError(
      `${context} is ${byteLength} bytes; maximum is ${outputArtifactLimits.bytesPerMetadataField}.`
    );
  }
}

export function boundedDiagnostic(value: unknown, remainingBytes: number): string {
  const message = value instanceof Error ? value.message : String(value);
  return truncateUtf8(message, Math.min(outputArtifactLimits.bytesPerDiagnostic, Math.max(0, remainingBytes))).value;
}

export function validateBaseArtifact(record: Record<string, unknown>): BaseArtifact {
  const id = optionalString(record, 'id', 'Artifact');
  const title = optionalString(record, 'title', 'Artifact');
  const caption = optionalString(record, 'caption', 'Artifact');
  return {
    ...(id == null ? {} : { id }),
    ...(title == null ? {} : { title }),
    ...(caption == null ? {} : { caption }),
    byteLength: [id, title, caption]
      .filter((value): value is string => value != null)
      .reduce((total, value) => total + utf8ByteLength(value), 0)
  };
}

export function artifactMetadata(base: BaseArtifact): Pick<OutputArtifact, 'id' | 'title' | 'caption'> {
  return {
    ...(base.id == null ? {} : { id: base.id }),
    ...(base.title == null ? {} : { title: base.title }),
    ...(base.caption == null ? {} : { caption: base.caption })
  };
}

export function publicOutputArtifact(artifact: ValidatedOutputArtifact): OutputArtifact {
  if (artifact.kind === 'json') {
    return withoutProperty(artifact, 'formattedValue');
  }
  if (artifact.kind === 'image') {
    return withoutProperty(artifact, 'source');
  }
  return artifact;
}

function withoutProperty<Value extends object, Key extends keyof Value>(value: Value, key: Key): Omit<Value, Key> {
  const output = { ...value };
  Reflect.deleteProperty(output, key);
  return output;
}
