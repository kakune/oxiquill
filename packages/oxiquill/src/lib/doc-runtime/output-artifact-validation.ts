export { publicOutputArtifact } from './output-validation-common.js';
import type { ArtifactStream, TableColumn, TableColumnType } from './types.js';
import { outputArtifactLimits, truncateUtf8, utf8ByteLength } from './output-limits.mjs';
import type { ValidatedArtifactResult, ValidationSuccess } from './output-validation-common.js';
import {
  ArtifactValidationError,
  contentByteBudget,
  plainRecord,
  plainArray,
  requiredOwnValue,
  requiredString,
  optionalString,
  optionalBoolean,
  optionalNonNegativeInteger,
  rejectTruncated,
  quoted,
  requireMetadataBudget,
  boundedDiagnostic,
  validateBaseArtifact,
  artifactMetadata
} from './output-validation-common.js';
import { validateChartArtifact } from './output-validation-chart.js';
import { validateJsonArtifact, safeJsonFormat } from './output-validation-json.js';
import { validateImageArtifact } from './output-validation-image.js';

export { outputArtifactLimits } from './output-limits.mjs';
export type {
  ValidatedJsonArtifact,
  ValidatedImageArtifact,
  ValidatedOutputArtifact,
  ValidatedArtifactResult
} from './output-validation-common.js';

const artifactStreams = new Set<ArtifactStream>(['stdout', 'stderr', 'display']);

const tableColumnTypes = new Set<TableColumnType>([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'null',
  'unknown'
]);

export function validateOutputArtifacts(outputs: readonly unknown[]): readonly ValidatedArtifactResult[] {
  const results: ValidatedArtifactResult[] = [];
  let validatedBytes = 0;
  let diagnosticBytes = 0;
  const artifactCount = Math.min(outputs.length, outputArtifactLimits.artifactsPerRun);

  for (let index = 0; index < artifactCount; index += 1) {
    try {
      const validated = validateOutputArtifact(
        outputs[index],
        outputArtifactLimits.validatedBytesPerRun - validatedBytes
      );
      validatedBytes += validated.byteLength;
      results.push({ status: 'valid', ...validated, index });
    } catch (error) {
      const message = boundedDiagnostic(error, outputArtifactLimits.diagnosticBytesPerRun - diagnosticBytes);
      diagnosticBytes += utf8ByteLength(message);
      results.push({
        status: 'error',
        message,
        index
      });
    }
  }

  if (outputs.length > outputArtifactLimits.artifactsPerRun) {
    const message = boundedDiagnostic(
      `Artifact limit exceeded: received ${outputs.length}, maximum ${outputArtifactLimits.artifactsPerRun}.`,
      outputArtifactLimits.diagnosticBytesPerRun - diagnosticBytes
    );
    results.push({
      status: 'error',
      message,
      index: outputArtifactLimits.artifactsPerRun
    });
  }

  return results;
}

function validateOutputArtifact(value: unknown, remainingBytes: number): ValidationSuccess {
  const record = plainRecord(value, 'Artifact');
  const kind = requiredString(record, 'kind', 'Artifact');

  switch (kind) {
    case 'text':
      return validateTextArtifact(record, remainingBytes);
    case 'json':
      return validateJsonArtifact(record, remainingBytes);
    case 'table':
      return validateTableArtifact(record, remainingBytes);
    case 'chart':
      return validateChartArtifact(record, remainingBytes);
    case 'image':
      return validateImageArtifact(record, remainingBytes);
    case 'html':
      return validateHtmlArtifact(record, remainingBytes);
    case '__oxiquill_error':
      throw new ArtifactValidationError(requiredString(record, 'message', 'Producer artifact error'));
    default:
      throw new ArtifactValidationError(`Unsupported artifact kind ${quoted(kind)}.`);
  }
}

function validateTextArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  const base = validateBaseArtifact(record);
  const stream = requiredString(record, 'stream', 'Text artifact');
  if (!artifactStreams.has(stream as ArtifactStream)) {
    throw new ArtifactValidationError(`Text artifact stream ${quoted(stream)} is not supported.`);
  }
  const content = requiredString(record, 'content', 'Text artifact');
  const producerTruncated = optionalBoolean(record, 'truncated', 'Text artifact') ?? false;
  const contentBudget = contentByteBudget(base.byteLength, remainingBytes);
  const bounded = truncateUtf8(content, Math.min(outputArtifactLimits.bytesPerTextJsonOrHtml, contentBudget));

  return {
    artifact: {
      ...artifactMetadata(base),
      kind: 'text',
      stream: stream as ArtifactStream,
      content: bounded.value,
      ...(producerTruncated || bounded.truncated ? { truncated: true } : {})
    },
    byteLength: base.byteLength + bounded.byteLength
  };
}

function validateTableArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  const base = validateBaseArtifact(record);
  const producerTruncated = optionalBoolean(record, 'truncated', 'Table artifact') ?? false;
  const rawColumns = plainArray(requiredOwnValue(record, 'columns', 'Table artifact'), 'Table artifact columns');
  const rawRows = plainArray(requiredOwnValue(record, 'rows', 'Table artifact'), 'Table artifact rows');
  const rowCount = optionalNonNegativeInteger(record, 'rowCount', 'Table artifact') ?? rawRows.length;
  if (rowCount < rawRows.length) {
    throw new ArtifactValidationError('Table artifact rowCount cannot be smaller than rows.length.');
  }

  const retainedColumnCount = Math.min(rawColumns.length, outputArtifactLimits.columnsPerTable);
  const columns = rawColumns.slice(0, retainedColumnCount).map((column, index) => validateTableColumn(column, index));
  if (new Set(columns.map((column) => column.key)).size !== columns.length) {
    throw new ArtifactValidationError('Table artifact column keys must be unique.');
  }

  let byteLength =
    base.byteLength +
    columns.reduce((total, column) => total + utf8ByteLength(column.key) + utf8ByteLength(column.label), 0);
  if (byteLength > remainingBytes) {
    throw new ArtifactValidationError('Table artifact metadata exceeds the remaining 16 MiB run limit.');
  }

  const rows: unknown[][] = [];
  const retainedRowCount = Math.min(rawRows.length, outputArtifactLimits.rowsPerTable);
  let truncated = producerTruncated || rawColumns.length > retainedColumnCount || rawRows.length > retainedRowCount;

  for (let rowIndex = 0; rowIndex < retainedRowCount; rowIndex += 1) {
    const rawRow = plainArray(rawRows[rowIndex], `Table artifact row ${rowIndex + 1}`);
    if (rawRow.length !== rawColumns.length) {
      throw new ArtifactValidationError(
        `Table artifact row ${rowIndex + 1} has ${rawRow.length} cells; expected ${rawColumns.length}.`
      );
    }

    const row: unknown[] = [];
    let rowWasTruncated = false;
    for (let columnIndex = 0; columnIndex < retainedColumnCount; columnIndex += 1) {
      const cellBudget = Math.max(0, remainingBytes - byteLength);
      const cell = validateTableCell(rawRow[columnIndex], cellBudget, rowIndex, columnIndex);
      row.push(cell.value);
      byteLength += cell.byteLength;
      rowWasTruncated ||= cell.truncated;
    }
    rows.push(row);
    if (rowWasTruncated || byteLength >= remainingBytes) {
      truncated = true;
      break;
    }
  }

  if (rows.length < retainedRowCount) truncated = true;

  return {
    artifact: {
      ...artifactMetadata(base),
      kind: 'table',
      columns,
      rows,
      rowCount,
      ...(truncated ? { truncated: true } : {})
    },
    byteLength
  };
}

function validateHtmlArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  rejectTruncated(record, 'HTML artifact');
  const base = validateBaseArtifact(record);
  const html = requiredString(record, 'html', 'HTML artifact');
  if (requiredOwnValue(record, 'sandboxed', 'HTML artifact') !== true) {
    throw new ArtifactValidationError('HTML artifact sandboxed must be true.');
  }
  const htmlBytes = utf8ByteLength(html);
  if (htmlBytes > outputArtifactLimits.bytesPerTextJsonOrHtml) {
    throw new ArtifactValidationError(
      `HTML artifact is ${htmlBytes} bytes; maximum is ${outputArtifactLimits.bytesPerTextJsonOrHtml}.`
    );
  }
  const byteLength = base.byteLength + htmlBytes;
  if (byteLength > remainingBytes) {
    throw new ArtifactValidationError('HTML artifact exceeds the remaining 16 MiB run limit.');
  }
  return {
    artifact: { ...artifactMetadata(base), kind: 'html', html, sandboxed: true },
    byteLength
  };
}

function validateTableColumn(value: unknown, index: number): TableColumn {
  const record = plainRecord(value, `Table artifact column ${index + 1}`);
  const type = optionalString(record, 'type', `Table artifact column ${index + 1}`);
  if (type != null && !tableColumnTypes.has(type as TableColumnType)) {
    throw new ArtifactValidationError(`Table artifact column ${index + 1} type ${quoted(type)} is not supported.`);
  }
  const key = requiredString(record, 'key', `Table artifact column ${index + 1}`);
  const label = requiredString(record, 'label', `Table artifact column ${index + 1}`);
  requireMetadataBudget(key, `Table artifact column ${index + 1} key`);
  requireMetadataBudget(label, `Table artifact column ${index + 1} label`);
  return {
    key,
    label,
    ...(type == null ? {} : { type: type as TableColumnType })
  };
}

function validateTableCell(
  value: unknown,
  maxBytes: number,
  rowIndex: number,
  columnIndex: number
): { value: unknown; byteLength: number; truncated: boolean } {
  if (value == null) {
    return maxBytes >= 1
      ? { value: value ?? null, byteLength: 1, truncated: false }
      : { value: '', byteLength: 0, truncated: true };
  }
  if (typeof value === 'boolean') {
    return maxBytes >= 1 ? { value, byteLength: 1, truncated: false } : { value: '', byteLength: 0, truncated: true };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ArtifactValidationError(
        `Table artifact cell ${rowIndex + 1}:${columnIndex + 1} must contain a finite number.`
      );
    }
    return maxBytes >= 8 ? { value, byteLength: 8, truncated: false } : { value: '', byteLength: 0, truncated: true };
  }
  if (typeof value === 'string') {
    const bounded = truncateUtf8(value, maxBytes);
    return { value: bounded.value, byteLength: bounded.byteLength, truncated: bounded.truncated };
  }
  const formatted = safeJsonFormat(value, maxBytes, `Table artifact cell ${rowIndex + 1}:${columnIndex + 1}`);
  return {
    value: formatted.formatted,
    byteLength: utf8ByteLength(formatted.formatted),
    truncated: formatted.truncated
  };
}
