import type { ImageArtifact } from './types.js';
import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import type { ValidationSuccess } from './output-validation-common.js';
import {
  ArtifactValidationError,
  requiredString,
  optionalString,
  rejectTruncated,
  quoted,
  validateBaseArtifact,
  artifactMetadata
} from './output-validation-common.js';

const imageMimes = new Set<ImageArtifact['mime']>(['image/png', 'image/jpeg', 'image/svg+xml']);

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export function validateImageArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  rejectTruncated(record, 'Image artifact');
  const base = validateBaseArtifact(record);
  const mime = requiredString(record, 'mime', 'Image artifact');
  if (!imageMimes.has(mime as ImageArtifact['mime'])) {
    throw new ArtifactValidationError(`Image artifact MIME type ${quoted(mime)} is not supported.`);
  }
  const data = requiredString(record, 'data', 'Image artifact');
  const alt = optionalString(record, 'alt', 'Image artifact');
  const validated =
    mime === 'image/svg+xml' ? validateSvgImage(data) : validateBase64Image(data, mime as 'image/png' | 'image/jpeg');
  if (validated.decodedBytes > outputArtifactLimits.decodedBytesPerImage) {
    throw new ArtifactValidationError(
      `Image artifact is ${validated.decodedBytes} decoded bytes; maximum is ${outputArtifactLimits.decodedBytesPerImage}.`
    );
  }
  const byteLength = base.byteLength + validated.decodedBytes + (alt ? utf8ByteLength(alt) : 0);
  if (byteLength > remainingBytes) {
    throw new ArtifactValidationError('Image artifact exceeds the remaining 16 MiB run limit.');
  }

  return {
    artifact: {
      ...artifactMetadata(base),
      kind: 'image',
      mime: mime as ImageArtifact['mime'],
      data: validated.data,
      source: validated.source,
      ...(alt == null ? {} : { alt })
    },
    byteLength
  };
}

function validateBase64Image(
  data: string,
  mime: 'image/png' | 'image/jpeg'
): { data: string; decodedBytes: number; source: string } {
  const parsed = parseDataUrl(data);
  const payload = parsed ? parsed.payload : data;
  if (parsed && parsed.mime !== mime) {
    throw new ArtifactValidationError(
      `Image artifact MIME mismatch: field is ${quoted(mime)}, data URL is ${quoted(parsed.mime)}.`
    );
  }
  if (parsed && !parsed.base64) {
    throw new ArtifactValidationError(`${mime} image data URLs must use base64 encoding.`);
  }
  const decodedBytes = validateBase64(payload);
  const header = decodeBase64Prefix(payload, mime === 'image/png' ? 8 : 3);
  const signature = mime === 'image/png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff];
  if (!signature.every((byte, index) => header[index] === byte)) {
    throw new ArtifactValidationError(`Image artifact payload does not match ${mime}.`);
  }
  return { data: payload, decodedBytes, source: `data:${mime};base64,${payload}` };
}

function validateSvgImage(data: string): { data: string; decodedBytes: number; source: string } {
  const parsed = parseDataUrl(data);
  if (parsed && parsed.mime !== 'image/svg+xml') {
    throw new ArtifactValidationError(
      `Image artifact MIME mismatch: field is image/svg+xml, data URL is ${quoted(parsed.mime)}.`
    );
  }
  let svg = data;
  let decodedBytes: number;
  if (parsed?.base64) {
    decodedBytes = validateBase64(parsed.payload);
    if (decodedBytes > outputArtifactLimits.decodedBytesPerImage) {
      throw new ArtifactValidationError(
        `Image artifact is ${decodedBytes} decoded bytes; maximum is ${outputArtifactLimits.decodedBytesPerImage}.`
      );
    }
    try {
      svg = utf8Decoder.decode(Uint8Array.from(atob(parsed.payload), (character) => character.charCodeAt(0)));
    } catch {
      throw new ArtifactValidationError('SVG image artifact must contain valid UTF-8 data.');
    }
  } else if (parsed) {
    try {
      svg = decodeURIComponent(parsed.payload);
    } catch {
      throw new ArtifactValidationError('SVG image data URL contains invalid percent encoding.');
    }
    decodedBytes = utf8ByteLength(svg);
  } else {
    decodedBytes = utf8ByteLength(svg);
  }
  if (!hasSvgRoot(svg)) {
    throw new ArtifactValidationError('SVG image artifact must contain an <svg> root element.');
  }
  let source: string;
  try {
    source = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  } catch {
    throw new ArtifactValidationError('SVG image artifact contains invalid Unicode data.');
  }
  return { data: svg, decodedBytes, source };
}

function hasSvgRoot(svg: string): boolean {
  const rootMatch = /<svg(?:\s|>)/u.exec(svg);
  if (!rootMatch) return false;
  const preamble = svg
    .slice(0, rootMatch.index)
    .replace(/^\s*<\?xml[\s\S]*?\?>/u, '')
    .replace(/^\s*<!DOCTYPE\s+svg[\s\S]*?>/u, '')
    .replace(/(?:^\s*<!--[\s\S]*?-->)+/gu, '');
  return preamble.trim().length === 0;
}

function parseDataUrl(data: string): { base64: boolean; mime: string; payload: string } | undefined {
  if (!data.startsWith('data:')) return undefined;
  const match = /^data:([^;,]+)(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/u.exec(data);
  if (!match) throw new ArtifactValidationError('Image artifact data URL is malformed.');
  const mime = match[1];
  const payload = match[3];
  if (mime == null || payload == null) {
    throw new ArtifactValidationError('Image artifact data URL is malformed.');
  }
  return { mime, base64: match[2] === ';base64', payload };
}

function validateBase64(payload: string): number {
  if (payload.length === 0 || payload.length % 4 !== 0) {
    throw new ArtifactValidationError('Image artifact contains invalid base64 data.');
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  const dataLength = payload.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const code = payload.charCodeAt(index);
    const isBase64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!isBase64Character) {
      throw new ArtifactValidationError('Image artifact contains invalid base64 data.');
    }
  }
  for (let index = dataLength; index < payload.length; index += 1) {
    if (payload[index] !== '=') {
      throw new ArtifactValidationError('Image artifact contains invalid base64 data.');
    }
  }
  return (payload.length / 4) * 3 - padding;
}

function decodeBase64Prefix(payload: string, byteCount: number): readonly number[] {
  try {
    return Array.from(atob(payload.slice(0, Math.ceil(byteCount / 3) * 4)), (character) => character.charCodeAt(0));
  } catch {
    throw new ArtifactValidationError('Image artifact contains invalid base64 data.');
  }
}
