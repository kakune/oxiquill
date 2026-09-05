import type {
  ArtifactStream,
  BaseChartSpec,
  ChartAxisType,
  ChartSpec,
  ChartPalette,
  LineChartStyle,
  ScatterChartStyle,
  HtmlArtifact,
  ImageArtifact,
  JsonArtifact,
  OutputArtifact,
  TableArtifact,
  TableColumn,
  TableColumnType,
  TextArtifact
} from './types.js';
import { outputArtifactLimits, truncateUtf8, utf8ByteLength } from './output-limits.mjs';

export { outputArtifactLimits } from './output-limits.mjs';

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

type ValidationSuccess = {
  artifact: ValidatedOutputArtifact;
  byteLength: number;
};

type JsonFormatResult = {
  formatted: string;
  safeValue: unknown;
  truncated: boolean;
};

type BaseArtifact = {
  caption?: string;
  id?: string;
  title?: string;
  byteLength: number;
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

const artifactStreams = new Set<ArtifactStream>(['stdout', 'stderr', 'display']);
const chartAxisTypes = new Set<ChartAxisType>(['value', 'category', 'time', 'log']);
const imageMimes = new Set<ImageArtifact['mime']>(['image/png', 'image/jpeg', 'image/svg+xml']);
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
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const maximumJsonNestingDepth = 100;

class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(truncateUtf8(message, outputArtifactLimits.bytesPerDiagnostic).value);
  }
}

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

function validateJsonArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
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

function validateChartArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  rejectTruncated(record, 'Chart artifact');
  const base = validateBaseArtifact(record);
  const spec = validateChartSpec(requiredOwnValue(record, 'spec', 'Chart artifact'));
  const byteLength = base.byteLength + payloadByteLength(spec);
  if (byteLength > remainingBytes) {
    throw new ArtifactValidationError('Chart artifact exceeds the remaining 16 MiB run limit.');
  }
  return {
    artifact: { ...artifactMetadata(base), kind: 'chart', spec },
    byteLength
  };
}

function validateImageArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
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

function validateBaseArtifact(record: Record<string, unknown>): BaseArtifact {
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

function artifactMetadata(base: BaseArtifact): Pick<OutputArtifact, 'id' | 'title' | 'caption'> {
  return {
    ...(base.id == null ? {} : { id: base.id }),
    ...(base.title == null ? {} : { title: base.title }),
    ...(base.caption == null ? {} : { caption: base.caption })
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

function validateChartSpec(value: unknown): ChartSpec {
  const record = plainRecord(value, 'Chart spec');
  const kind = requiredString(record, 'kind', 'Chart spec');
  const base = {
    ...validateBaseChartSpec(record),
    ...(Object.hasOwn(record, 'style')
      ? { style: validateChartStyle(requiredOwnValue(record, 'style', 'Chart spec'), kind) }
      : {})
  };

  switch (kind) {
    case 'line': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType)
      };
    }
    case 'scatter': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType)
      };
    }
    case 'area': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType)
      };
    }
    case 'bar': {
      requireEffectiveAxis(base.xType, 'category', 'Bar chart x axis');
      const yType = numericAxisType(base.yType, 'Bar chart y axis');
      const categories = stringArray(requiredOwnValue(record, 'categories', 'Bar chart'), 'Bar chart categories');
      if (categories.length > outputArtifactLimits.chartDataItems) {
        throw chartLimitError(categories.length);
      }
      const rawSeries = plainArray(requiredOwnValue(record, 'series', 'Bar chart'), 'Bar chart series');
      if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
      let dataItems = 0;
      const series = rawSeries.map((seriesValue, seriesIndex) => {
        const seriesRecord = plainRecord(seriesValue, `Bar chart series ${seriesIndex + 1}`);
        const values = plainArray(
          requiredOwnValue(seriesRecord, 'values', `Bar chart series ${seriesIndex + 1}`),
          `Bar chart series ${seriesIndex + 1} values`
        );
        if (dataItems + values.length > outputArtifactLimits.chartDataItems) {
          throw chartLimitError(dataItems + values.length);
        }
        const validatedValues = values.map((item, valueIndex) => {
          if (item === null) return null;
          return numericCoordinate(item, yType, `Bar chart series ${seriesIndex + 1} value ${valueIndex + 1}`);
        });
        if (validatedValues.length !== categories.length) {
          throw new ArtifactValidationError(
            `Bar chart series ${seriesIndex + 1} has ${validatedValues.length} values; expected ${categories.length}.`
          );
        }
        dataItems += validatedValues.length;
        const name = optionalString(seriesRecord, 'name', `Bar chart series ${seriesIndex + 1}`);
        return { ...(name == null ? {} : { name }), values: validatedValues };
      });
      return { ...base, kind, categories, series };
    }
    case 'histogram': {
      requireEffectiveAxis(base.xType, 'category', 'Histogram chart x axis');
      const yType = numericAxisType(base.yType, 'Histogram chart y axis');
      const rawBins = plainArray(requiredOwnValue(record, 'bins', 'Histogram chart'), 'Histogram chart bins');
      if (rawBins.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawBins.length);
      const bins = rawBins.map((bin, binIndex) => {
        const tuple = fixedTuple(bin, 3, `Histogram chart bin ${binIndex + 1}`);
        const lower = finiteNumber(tuple[0], `Histogram chart bin ${binIndex + 1} lower bound`);
        const upper = finiteNumber(tuple[1], `Histogram chart bin ${binIndex + 1} upper bound`);
        if (lower >= upper) {
          throw new ArtifactValidationError(
            `Histogram chart bin ${binIndex + 1} lower bound must be smaller than its upper bound.`
          );
        }
        const count = numericCoordinate(tuple[2], yType, `Histogram chart bin ${binIndex + 1} count`);
        if (count < 0) {
          throw new ArtifactValidationError(`Histogram chart bin ${binIndex + 1} count must not be negative.`);
        }
        return [lower, upper, count] as const;
      });
      return { ...base, kind, bins };
    }
    case 'heatmap': {
      const { xType: declaredXType, yType: declaredYType, ...heatmapBase } = base;
      const xCategories = optionalStringArray(record, 'xCategories', 'Heatmap chart');
      const yCategories = optionalStringArray(record, 'yCategories', 'Heatmap chart');
      const xCategoryNames = xCategories
        ? requireUniqueCategories(xCategories, 'Heatmap chart xCategories')
        : undefined;
      const yCategoryNames = yCategories
        ? requireUniqueCategories(yCategories, 'Heatmap chart yCategories')
        : undefined;
      requireEffectiveAxis(declaredXType, 'category', 'Heatmap chart x axis');
      requireEffectiveAxis(declaredYType, 'category', 'Heatmap chart y axis');
      const rawData = plainArray(requiredOwnValue(record, 'data', 'Heatmap chart'), 'Heatmap chart data');
      if (rawData.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawData.length);
      const data = rawData.map((cell, cellIndex) => {
        const tuple = fixedTuple(cell, 3, `Heatmap chart cell ${cellIndex + 1}`);
        return [
          heatmapCoordinate(tuple[0], `Heatmap chart cell ${cellIndex + 1} x coordinate`, xCategories, xCategoryNames),
          heatmapCoordinate(tuple[1], `Heatmap chart cell ${cellIndex + 1} y coordinate`, yCategories, yCategoryNames),
          finiteNumber(tuple[2], `Heatmap chart cell ${cellIndex + 1} value`)
        ] as const;
      });
      return {
        ...heatmapBase,
        kind,
        ...(declaredXType == null ? {} : { xType: 'category' as const }),
        ...(declaredYType == null ? {} : { yType: 'category' as const }),
        ...(xCategories == null ? {} : { xCategories }),
        ...(yCategories == null ? {} : { yCategories }),
        data
      };
    }
    default:
      throw new ArtifactValidationError(`Chart kind ${quoted(kind)} is not supported.`);
  }
}

function validateChartStyle(value: unknown, kind: string): LineChartStyle & ScatterChartStyle {
  const context = `${kind} chart style`;
  const record = plainRecord(value, context);
  const line = kind === 'line' || kind === 'area';
  rejectUnknownStyleFields(
    record,
    [
      'palette',
      'showGrid',
      'animation',
      'animationDurationMs',
      ...(line ? ['lineWidth'] : []),
      ...(kind === 'scatter' ? ['symbolSize'] : [])
    ],
    context
  );
  const style: LineChartStyle & ScatterChartStyle = {};
  for (const field of ['showGrid', 'animation'] as const) {
    if (Object.hasOwn(record, field)) style[field] = optionalBoolean(record, field, context);
  }
  for (const [field, minimum, maximum] of [
    ['animationDurationMs', 0, 2000],
    ['lineWidth', 1, 8],
    ['symbolSize', 2, 32]
  ] as const) {
    if (!Object.hasOwn(record, field)) continue;
    const number = requiredOwnValue(record, field, context);
    if (
      typeof number !== 'number' ||
      !Number.isFinite(number) ||
      number < minimum ||
      number > maximum ||
      (field === 'animationDurationMs' && !Number.isInteger(number))
    ) {
      throw new ArtifactValidationError(
        `${context} ${field} must be ${field === 'animationDurationMs' ? 'an integer' : 'finite'} within ${minimum}–${maximum}.`
      );
    }
    style[field] = number;
  }
  if (Object.hasOwn(record, 'palette')) {
    const palette = plainRecord(requiredOwnValue(record, 'palette', context), `${context} palette`);
    rejectUnknownStyleFields(palette, ['light', 'dark'], `${context} palette`);
    if (Reflect.ownKeys(palette).length === 0)
      throw new ArtifactValidationError(`${context} palette must contain light or dark colors.`);
    const validated: ChartPalette = {};
    for (const theme of ['light', 'dark'] as const) {
      if (!Object.hasOwn(palette, theme)) continue;
      const colors = plainArray(requiredOwnValue(palette, theme, context), `${context} palette.${theme}`);
      const minimum = kind === 'heatmap' ? 2 : 1;
      if (colors.length < minimum || colors.length > 12)
        throw new ArtifactValidationError(`${context} palette.${theme} must contain ${minimum}–12 colors.`);
      const seen = new Set<string>();
      validated[theme] = colors.map((color) => {
        if (typeof color !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(color)) {
          throw new ArtifactValidationError(`${context} palette colors must be #RGB or #RRGGBB.`);
        }
        const normalized = (
          color.length === 4 ? Array.from(color.slice(1), (part) => part + part).join('') : color.slice(1)
        ).toLowerCase();
        if (seen.has(normalized))
          throw new ArtifactValidationError(`${context} palette.${theme} colors must be unique.`);
        seen.add(normalized);
        return color;
      });
    }
    style.palette = validated;
  }
  return style;
}

function rejectUnknownStyleFields(record: Record<string, unknown>, allowed: readonly string[], context: string): void {
  for (const field of Reflect.ownKeys(record)) {
    if (typeof field !== 'string' || !allowed.includes(field)) {
      throw new ArtifactValidationError(`${context} has unknown field ${quoted(String(field))}.`);
    }
  }
}

function validateBaseChartSpec(record: Record<string, unknown>): BaseChartSpec {
  const title = optionalString(record, 'title', 'Chart spec');
  const xLabel = optionalString(record, 'xLabel', 'Chart spec');
  const yLabel = optionalString(record, 'yLabel', 'Chart spec');
  const xType = optionalString(record, 'xType', 'Chart spec');
  const yType = optionalString(record, 'yType', 'Chart spec');
  if (xType != null && !chartAxisTypes.has(xType as ChartAxisType)) {
    throw new ArtifactValidationError(`Chart xType ${quoted(xType)} is not supported.`);
  }
  if (yType != null && !chartAxisTypes.has(yType as ChartAxisType)) {
    throw new ArtifactValidationError(`Chart yType ${quoted(yType)} is not supported.`);
  }
  const legend = optionalBoolean(record, 'legend', 'Chart spec');
  const tooltip = optionalBoolean(record, 'tooltip', 'Chart spec');
  const dataZoom = optionalBoolean(record, 'dataZoom', 'Chart spec');
  return {
    ...(title == null ? {} : { title }),
    ...(xLabel == null ? {} : { xLabel }),
    ...(yLabel == null ? {} : { yLabel }),
    ...(xType == null ? {} : { xType: xType as ChartAxisType }),
    ...(yType == null ? {} : { yType: yType as ChartAxisType }),
    ...(legend == null ? {} : { legend }),
    ...(tooltip == null ? {} : { tooltip }),
    ...(dataZoom == null ? {} : { dataZoom })
  } as Omit<ChartSpec, 'kind'>;
}

function validateXySeries(
  value: unknown,
  xType: ChartAxisType,
  yType: ChartAxisType
): Extract<ChartSpec, { kind: 'line' }>['series'] {
  const rawSeries = plainArray(value, 'XY chart series');
  if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
  let dataItems = 0;
  return rawSeries.map((seriesValue, seriesIndex) => {
    const record = plainRecord(seriesValue, `XY chart series ${seriesIndex + 1}`);
    const rawPoints = plainArray(
      requiredOwnValue(record, 'points', `XY chart series ${seriesIndex + 1}`),
      `XY chart series ${seriesIndex + 1} points`
    );
    dataItems += Math.max(rawPoints.length, 1);
    if (dataItems > outputArtifactLimits.chartDataItems) throw chartLimitError(dataItems);
    const points = rawPoints.map((point, pointIndex) => {
      const tuple = fixedTuple(point, 2, `XY chart series ${seriesIndex + 1} point ${pointIndex + 1}`);
      return [
        chartCoordinate(tuple[0], xType, `XY chart series ${seriesIndex + 1} point ${pointIndex + 1} x coordinate`),
        chartCoordinate(tuple[1], yType, `XY chart series ${seriesIndex + 1} point ${pointIndex + 1} y coordinate`)
      ] as const;
    });
    const name = optionalString(record, 'name', `XY chart series ${seriesIndex + 1}`);
    return { ...(name == null ? {} : { name }), points };
  });
}

function safeJsonFormat(value: unknown, maxBytes: number, context: string): JsonFormatResult {
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

function contentByteBudget(metadataBytes: number, remainingBytes: number): number {
  if (metadataBytes > remainingBytes) {
    throw new ArtifactValidationError('Artifact metadata exceeds the remaining 16 MiB run limit.');
  }
  return remainingBytes - metadataBytes;
}

function payloadByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}

function plainRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ArtifactValidationError(`${context} must be a plain record.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ArtifactValidationError(`${context} must not have a custom prototype.`);
  }
  return value as Record<string, unknown>;
}

function plainArray(value: unknown, context: string): unknown[] {
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

function dataDescriptor(record: object, key: PropertyKey, context: string): PropertyDescriptor & { value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new ArtifactValidationError(`${context} field ${quoted(String(key))} must be an own data property.`);
  }
  return descriptor as PropertyDescriptor & { value: unknown };
}

function requiredOwnValue(record: Record<string, unknown>, key: string, context: string): unknown {
  return dataDescriptor(record, key, context).value;
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'string') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a string.`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string, context: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'string') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a string when provided.`);
  }
  requireMetadataBudget(value, `${context} field ${quoted(key)}`);
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, context: string): boolean | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'boolean') {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a boolean when provided.`);
  }
  return value;
}

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string, context: string): number | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = requiredOwnValue(record, key, context);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactValidationError(`${context} field ${quoted(key)} must be a non-negative safe integer.`);
  }
  return value;
}

function rejectTruncated(record: Record<string, unknown>, context: string): void {
  if (Object.hasOwn(record, 'truncated')) {
    throw new ArtifactValidationError(`${context} does not support the truncated field.`);
  }
}

function fixedTuple(value: unknown, length: number, context: string): unknown[] {
  const tuple = plainArray(value, context);
  if (tuple.length !== length || tuple.some((_, index) => !Object.hasOwn(tuple, index))) {
    throw new ArtifactValidationError(`${context} must contain exactly ${length} values.`);
  }
  return tuple;
}

function stringArray(value: unknown, context: string): string[] {
  const values = plainArray(value, context);
  if (values.length > outputArtifactLimits.chartDataItems) throw chartLimitError(values.length);
  return values.map((item, index) => {
    if (typeof item !== 'string') {
      throw new ArtifactValidationError(`${context} item ${index + 1} must be a string.`);
    }
    return item;
  });
}

function optionalStringArray(record: Record<string, unknown>, key: string, context: string): string[] | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const values = stringArray(requiredOwnValue(record, key, context), `${context} ${key}`);
  if (values.length > outputArtifactLimits.chartDataItems) throw chartLimitError(values.length);
  return values;
}

function finiteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArtifactValidationError(`${context} must be a finite number.`);
  }
  return value;
}

function chartCoordinate(value: unknown, axisType: ChartAxisType, context: string): number | string {
  switch (axisType) {
    case 'value':
    case 'log':
      return numericCoordinate(value, axisType, context);
    case 'time':
      if (typeof value === 'number') return finiteNumber(value, context);
      if (typeof value === 'string' && isSupportedIsoDateTime(value)) return value;
      throw new ArtifactValidationError(
        `${context} must be finite epoch milliseconds or an ISO-8601 date-time with an explicit time zone.`
      );
    case 'category': {
      if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new ArtifactValidationError(`${context} must be a string or finite numeric category coordinate.`);
      }
      return value;
    }
  }
}

function heatmapCoordinate(
  value: unknown,
  context: string,
  categories?: readonly string[],
  categoryNames?: ReadonlySet<string>
): number | string {
  if (typeof value === 'string') {
    if (categoryNames && !categoryNames.has(value)) {
      throw new ArtifactValidationError(`${context} is not present in the declared categories.`);
    }
    return value;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ArtifactValidationError(`${context} must be a string or finite numeric category coordinate.`);
  }
  if (categories && (!Number.isSafeInteger(value) || value < 0 || value >= categories.length)) {
    throw new ArtifactValidationError(`${context} must be a safe integer index into the declared categories.`);
  }
  return value;
}

function numericCoordinate(value: unknown, axisType: 'value' | 'log' | 'time', context: string): number {
  const number = finiteNumber(value, context);
  if (axisType === 'log' && number <= 0) {
    throw new ArtifactValidationError(`${context} must be strictly positive for a log axis.`);
  }
  return number;
}

function requireEffectiveAxis(
  declaredType: ChartAxisType | undefined,
  effectiveType: ChartAxisType,
  context: string
): void {
  if (declaredType != null && declaredType !== effectiveType) {
    throw new ArtifactValidationError(`${context} is always ${effectiveType}; received ${declaredType}.`);
  }
}

function numericAxisType(declaredType: ChartAxisType | undefined, context: string): 'value' | 'log' | 'time' {
  if (declaredType === 'category') {
    throw new ArtifactValidationError(`${context} cannot be category because its data is numeric.`);
  }
  return declaredType ?? 'value';
}

function requireUniqueCategories(categories: readonly string[], context: string): ReadonlySet<string> {
  const categoryNames = new Set(categories);
  if (categoryNames.size !== categories.length) {
    throw new ArtifactValidationError(`${context} must not contain duplicate values.`);
  }
  return categoryNames;
}

function isSupportedIsoDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const offsetHours = Number(zone?.slice(1, 3));
    const offsetMinutes = Number(zone?.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year: number, month: number): number {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

function chartLimitError(dataItems: number): ArtifactValidationError {
  return new ArtifactValidationError(
    `Chart contains ${dataItems} data items; maximum is ${outputArtifactLimits.chartDataItems}.`
  );
}

function quoted(value: string): string {
  return JSON.stringify(truncateUtf8(value, 256).value);
}

function requireMetadataBudget(value: string, context: string): void {
  const byteLength = utf8ByteLength(value);
  if (byteLength > outputArtifactLimits.bytesPerMetadataField) {
    throw new ArtifactValidationError(
      `${context} is ${byteLength} bytes; maximum is ${outputArtifactLimits.bytesPerMetadataField}.`
    );
  }
}

function jsonObjectPath(path: string, key: string): string {
  return truncateUtf8(`${path}.${key}`, outputArtifactLimits.bytesPerDiagnostic / 2).value;
}

function boundedDiagnostic(value: unknown, remainingBytes: number): string {
  const message = value instanceof Error ? value.message : String(value);
  return truncateUtf8(message, Math.min(outputArtifactLimits.bytesPerDiagnostic, Math.max(0, remainingBytes))).value;
}
