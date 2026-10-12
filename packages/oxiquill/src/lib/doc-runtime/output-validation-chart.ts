import type {
  BaseChartSpec,
  ChartAxisType,
  ChartNumberFormat,
  LineSeriesStyle,
  ChartSpec,
  ChartPalette,
  LineChartStyle,
  ScatterChartStyle
} from './types.js';
import { validateChartStacks } from './chart-stacks.js';
import { outputArtifactLimits } from './output-limits.mjs';
import { histogramHeight } from './chart-histogram.js';
import { chartAxisType } from './chart-axes.js';
import type { ValidationSuccess } from './output-validation-common.js';
import {
  ArtifactValidationError,
  payloadByteLength,
  plainRecord,
  plainArray,
  requiredOwnValue,
  requiredString,
  optionalString,
  optionalBoolean,
  rejectTruncated,
  finiteNumber,
  quoted,
  validateBaseArtifact,
  artifactMetadata
} from './output-validation-common.js';

const chartAxisTypes = new Set<ChartAxisType>(['value', 'category', 'time', 'log']);

export function validateChartArtifact(record: Record<string, unknown>, remainingBytes: number): ValidationSuccess {
  rejectTruncated(record, 'Chart artifact');
  const base = validateBaseArtifact(record);
  const spec = validateChartSpec(requiredOwnValue(record, 'spec', 'Chart artifact'));
  validateChartStacks(spec);
  const byteLength = base.byteLength + payloadByteLength(spec);
  if (byteLength > remainingBytes) {
    throw new ArtifactValidationError('Chart artifact exceeds the remaining 16 MiB run limit.');
  }
  return {
    artifact: { ...artifactMetadata(base), kind: 'chart', spec },
    byteLength
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

  validateChartRanges({ ...base, kind });

  switch (kind) {
    case 'line': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType, kind)
      };
    }
    case 'scatter': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType, kind)
      };
    }
    case 'area': {
      const xType = base.xType ?? 'value';
      const yType = base.yType ?? 'value';
      return {
        ...base,
        kind,
        series: validateXySeries(requiredOwnValue(record, 'series', `${kind} chart`), xType, yType, kind)
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
      const ids = new Set<string>();
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
        return { ...validateSeriesPresentation(seriesRecord, kind, seriesIndex, ids), values: validatedValues };
      });
      const { yType: declaredYType, ...barBase } = base;
      return { ...barBase, kind, ...(declaredYType == null ? {} : { yType }), categories, series };
    }
    case 'histogram': {
      if (base.xType !== undefined && base.xType !== 'value' && base.xType !== 'category')
        throw new ArtifactValidationError('Histogram chart x axis must be value.');
      const mode = optionalString(record, 'mode', 'Histogram chart');
      if (mode !== undefined && mode !== 'count' && mode !== 'density')
        throw new ArtifactValidationError('Histogram chart mode must be count or density.');
      const yType = numericAxisType(base.yType, 'Histogram chart y axis');
      const rawBins = plainArray(requiredOwnValue(record, 'bins', 'Histogram chart'), 'Histogram chart bins');
      if (rawBins.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawBins.length);
      const bins = rawBins.map((rawBin, binIndex) => {
        const tuple = fixedTuple(rawBin, 3, `Histogram chart bin ${binIndex + 1}`);
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
        const bin = [lower, upper, count] as const;
        if (mode === 'density') {
          const width = upper - lower;
          const height = histogramHeight(bin, mode);
          if (!Number.isFinite(width) || !Number.isFinite(height) || (yType === 'log' && height <= 0))
            throw new ArtifactValidationError(
              `Histogram chart bin ${binIndex + 1} density must be finite and positive for log axes.`
            );
        }
        return bin;
      });
      const ordered = bins.map((bin, index) => ({ bin, index })).sort((a, b) => a.bin[0] - b.bin[0]);
      for (let index = 1; index < ordered.length; index++) {
        if (ordered[index].bin[0] < ordered[index - 1].bin[1])
          throw new ArtifactValidationError(
            `Histogram chart bins ${ordered[index - 1].index + 1} and ${ordered[index].index + 1} overlap.`
          );
      }
      const { xType: declaredXType, yType: declaredYType, ...histogramBase } = base;
      return {
        ...histogramBase,
        kind,
        ...(declaredXType == null ? {} : { xType: 'value' as const }),
        ...(declaredYType == null ? {} : { yType }),
        ...(mode === undefined ? {} : { mode }),
        bins
      };
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
      'renderer',
      'xFormat',
      'yFormat',
      ...(kind === 'heatmap' ? ['valueFormat'] : []),
      'showGrid',
      'animation',
      'animationDurationMs',
      'height',
      ...(line ? ['lineWidth'] : []),
      ...(kind === 'scatter' ? ['symbolSize'] : [])
    ],
    context
  );
  const style: LineChartStyle & ScatterChartStyle = {};
  if (Object.hasOwn(record, 'renderer')) {
    if (record.renderer !== 'canvas' && record.renderer !== 'svg')
      throw new ArtifactValidationError(`${context} renderer must be canvas or svg.`);
    style.renderer = record.renderer;
  }
  for (const field of ['xFormat', 'yFormat', 'valueFormat'] as const) {
    if (Object.hasOwn(record, field))
      style[field] = validateNumberFormat(requiredOwnValue(record, field, context), context + ' ' + field);
  }
  for (const field of ['showGrid', 'animation'] as const) {
    if (Object.hasOwn(record, field)) style[field] = optionalBoolean(record, field, context);
  }
  for (const [field, minimum, maximum] of [
    ['animationDurationMs', 0, 2000],
    ['height', 200, 800],
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
      ((field === 'animationDurationMs' || field === 'height') && !Number.isInteger(number))
    ) {
      throw new ArtifactValidationError(
        `${context} ${field} must be ${field === 'animationDurationMs' || field === 'height' ? 'an integer' : 'finite'} within ${minimum}–${maximum}.`
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
      validated[theme] = colors.map((value) => {
        const color = validateChartColor(value, context + ' palette');
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

function validateNumberFormat(value: unknown, context: string): ChartNumberFormat {
  const record = plainRecord(value, context);
  rejectUnknownStyleFields(record, ['significantDigits', 'fractionDigits', 'unit', 'notation'], context);
  const format: ChartNumberFormat = {};
  for (const [field, min, max] of [
    ['significantDigits', 1, 17],
    ['fractionDigits', 0, 20]
  ] as const) {
    if (!Object.hasOwn(record, field)) continue;
    const number = finiteNumber(requiredOwnValue(record, field, context), context + ' ' + field);
    if (!Number.isInteger(number) || number < min || number > max)
      throw new ArtifactValidationError(`${context} ${field} must be an integer within ${min}–${max}.`);
    format[field] = number;
  }
  if (format.significantDigits !== undefined && format.fractionDigits !== undefined)
    throw new ArtifactValidationError(`${context} cannot combine significantDigits and fractionDigits.`);
  const unit = optionalString(record, 'unit', context);
  const notation = optionalString(record, 'notation', context);
  if (notation !== undefined && notation !== 'auto' && notation !== 'si')
    throw new ArtifactValidationError(`${context} notation must be auto or si.`);
  return { ...format, ...(unit === undefined ? {} : { unit }), ...(notation === undefined ? {} : { notation }) };
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
  const ranges: BaseChartSpec = {};
  for (const field of ['xMin', 'xMax', 'yMin', 'yMax'] as const) {
    if (Object.hasOwn(record, field))
      ranges[field] = finiteNumber(requiredOwnValue(record, field, 'Chart spec'), `Chart ${field}`);
  }
  for (const field of ['xIncludeZero', 'yIncludeZero'] as const) {
    if (Object.hasOwn(record, field)) ranges[field] = optionalBoolean(record, field, 'Chart spec');
  }
  return {
    ...ranges,
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

function validateChartRanges(spec: BaseChartSpec & { kind: string }): void {
  for (const axis of ['x', 'y'] as const) {
    const type = chartAxisType(spec, axis);
    const min = spec[axis === 'x' ? 'xMin' : 'yMin'];
    const max = spec[axis === 'x' ? 'xMax' : 'yMax'];
    const zero = spec[axis === 'x' ? 'xIncludeZero' : 'yIncludeZero'];
    if (spec.style?.[axis === 'x' ? 'xFormat' : 'yFormat'] !== undefined && type !== 'value' && type !== 'log')
      throw new ArtifactValidationError(`Chart ${axis}Format requires a value or log axis.`);
    if (type === 'category' && (min !== undefined || max !== undefined))
      throw new ArtifactValidationError(`Chart ${axis} axis does not accept numeric bounds for categories.`);
    if (zero !== undefined && type !== 'value')
      throw new ArtifactValidationError(`Chart ${axis}IncludeZero requires a value axis.`);
    if (min !== undefined && max !== undefined && min >= max)
      throw new ArtifactValidationError(`Chart ${axis}Min must be smaller than ${axis}Max.`);
    if (type === 'log' && ((min !== undefined && min <= 0) || (max !== undefined && max <= 0)))
      throw new ArtifactValidationError(`Chart ${axis} bounds must be strictly positive for a log axis.`);
    if (
      type === 'time' &&
      [min, max].some((value) => value !== undefined && !Number.isFinite(new Date(value).getTime()))
    )
      throw new ArtifactValidationError(`Chart ${axis} bounds must be valid epoch milliseconds.`);
    if (
      axis === 'y' &&
      type === 'value' &&
      ['bar', 'histogram', 'area'].includes(spec.kind) &&
      (zero === false || (min !== undefined && min > 0) || (max !== undefined && max < 0))
    )
      throw new ArtifactValidationError(`Chart ${spec.kind} value y range must include zero.`);
  }
}

function validateXySeries(
  value: unknown,
  xType: ChartAxisType,
  yType: ChartAxisType,
  kind: 'line' | 'scatter' | 'area'
): Extract<ChartSpec, { kind: 'area' }>['series'] {
  const rawSeries = plainArray(value, 'XY chart series');
  if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
  let dataItems = 0;
  const ids = new Set<string>();
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
    return { ...validateSeriesPresentation(record, kind, seriesIndex, ids), points };
  });
}

function validateSeriesPresentation(record: Record<string, unknown>, kind: string, index: number, ids: Set<string>) {
  const context = `${kind} chart series ${index + 1}`;
  const id = optionalString(record, 'id', context);
  const name = optionalString(record, 'name', context);
  const stack = optionalString(record, 'stack', context);
  if (stack !== undefined && (!['bar', 'area'].includes(kind) || !stack.trim()))
    throw new ArtifactValidationError(`${context} stack requires a non-empty group on bar or area charts.`);
  if (id !== undefined) {
    if (!id.trim() || ids.has(id)) throw new ArtifactValidationError(`${context} id must be non-empty and unique.`);
    ids.add(id);
  }
  const presentation = {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(stack === undefined ? {} : { stack })
  };
  if (!Object.hasOwn(record, 'style')) return presentation;
  const styleRecord = plainRecord(requiredOwnValue(record, 'style', context), context + ' style');
  const line = kind === 'line' || kind === 'area';
  rejectUnknownStyleFields(
    styleRecord,
    ['color', ...(kind !== 'bar' ? ['symbol'] : []), ...(line ? ['lineType', 'smooth', 'step', 'showSymbol'] : [])],
    context + ' style'
  );
  const style: LineSeriesStyle = {};
  if (Object.hasOwn(styleRecord, 'color')) {
    const color = requiredOwnValue(styleRecord, 'color', context);
    if (typeof color === 'string') style.color = validateChartColor(color, context);
    else {
      const colors = plainRecord(color, context + ' color');
      rejectUnknownStyleFields(colors, ['light', 'dark'], context + ' color');
      if (Reflect.ownKeys(colors).length === 0)
        throw new ArtifactValidationError(`${context} color requires light or dark.`);
      const validated: { light?: string; dark?: string } = {};
      for (const theme of ['light', 'dark'] as const)
        if (Object.hasOwn(colors, theme))
          validated[theme] = validateChartColor(requiredOwnValue(colors, theme, context), context);
      style.color = validated;
    }
  }
  for (const field of ['smooth', 'showSymbol'] as const)
    if (Object.hasOwn(styleRecord, field)) style[field] = optionalBoolean(styleRecord, field, context);
  if (Object.hasOwn(styleRecord, 'lineType')) {
    const value = requiredOwnValue(styleRecord, 'lineType', context);
    if (value !== 'solid' && value !== 'dashed' && value !== 'dotted')
      throw new ArtifactValidationError(`${context} lineType must be solid, dashed, or dotted.`);
    style.lineType = value;
  }
  if (Object.hasOwn(styleRecord, 'step')) {
    const value = requiredOwnValue(styleRecord, 'step', context);
    if (value !== false && value !== 'start' && value !== 'middle' && value !== 'end')
      throw new ArtifactValidationError(`${context} step must be false, start, middle, or end.`);
    style.step = value;
  }
  if (style.smooth && style.step) throw new ArtifactValidationError(`${context} cannot combine smooth and step.`);
  if (Object.hasOwn(styleRecord, 'symbol')) {
    const value = requiredOwnValue(styleRecord, 'symbol', context);
    if (
      value !== 'circle' &&
      value !== 'emptyCircle' &&
      value !== 'rect' &&
      value !== 'triangle' &&
      value !== 'diamond' &&
      value !== 'none'
    )
      throw new ArtifactValidationError(`${context} has an unsupported symbol.`);
    style.symbol = value;
  }
  return { ...presentation, style };
}

function validateChartColor(value: unknown, context: string): string {
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3}|[\da-f]{6})$/iu.test(value))
    throw new ArtifactValidationError(`${context} colors must be #RGB or #RRGGBB.`);
  return value;
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

function numericAxisType(declaredType: ChartAxisType | undefined, context: string): 'value' | 'log' {
  if (declaredType === 'category' || declaredType === 'time') {
    throw new ArtifactValidationError(`${context} must be value or log; received ${declaredType}.`);
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
