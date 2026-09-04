export const outputArtifactLimits = Object.freeze({
  artifactsPerRun: 100,
  bytesPerDiagnostic: 8 * 1024,
  bytesPerError: 16 * 1024,
  bytesPerMetadataField: 16 * 1024,
  bytesPerStream: 1024 * 1024,
  bytesPerTextJsonOrHtml: 1024 * 1024,
  chartDataItems: 100_000,
  columnsPerTable: 100,
  decodedBytesPerImage: 10 * 1024 * 1024,
  diagnosticBytesPerRun: 64 * 1024,
  rowsPerTable: 10_000,
  validatedBytesPerRun: 16 * 1024 * 1024,
  workerResponseBytes: 16 * 1024 * 1024
});

const utf8Encoder = new TextEncoder();
const unknownErrorMessage = 'Unknown error.';

export function utf8ByteLength(value) {
  return utf8Encoder.encode(value).byteLength;
}

export function truncateUtf8(value, maxBytes) {
  const byteLength = utf8ByteLength(value);
  if (byteLength <= maxBytes) return { value, byteLength, truncated: false };
  if (maxBytes <= 0) return { value: '', byteLength: 0, truncated: true };
  const marker = '…';
  const markerBytes = utf8ByteLength(marker);
  if (maxBytes < markerBytes) return { value: '', byteLength: 0, truncated: true };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (utf8ByteLength(candidate) + markerBytes <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const lastCodeUnit = value.charCodeAt(low - 1);
  if (low > 0 && lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) low -= 1;
  const bounded = `${value.slice(0, low)}${marker}`;
  return { value: bounded, byteLength: utf8ByteLength(bounded), truncated: true };
}

export function boundedErrorMessage(value) {
  let message;
  try {
    const extracted = value instanceof Error ? value.message : value;
    message = typeof extracted === 'string' ? extracted : String(extracted);
  } catch {
    message = unknownErrorMessage;
  }

  const normalized = message.trim() === '' ? unknownErrorMessage : message;
  return truncateUtf8(normalized, outputArtifactLimits.bytesPerError).value;
}

export function createBoundedTextAccumulator(maxBytes = outputArtifactLimits.bytesPerStream, separator = '') {
  const chunks = [];
  let byteLength = 0;
  let truncated = false;

  return {
    append(value) {
      if (truncated) return;
      const candidate = chunks.length > 0 ? `${separator}${value}` : value;
      const bounded = truncateUtf8(candidate, maxBytes - byteLength);
      if (bounded.value) chunks.push(bounded.value);
      byteLength += bounded.byteLength;
      truncated = bounded.truncated;
    },
    take() {
      return { value: chunks.join(''), truncated };
    }
  };
}
