import { heatmapColorScale } from './chart-color-scale.js';
import type {
  BaseChartSpec,
  BubblePoint,
  BubbleSizeMapping,
  BoxplotValue,
  ChartAnnotation,
  IntervalPoint,
  ChartAxisType,
  ChartNumberFormat,
  LineSeriesStyle,
  ChartSpec,
  ChartPalette,
  LineChartStyle,
  ScatterChartStyle
} from './types.js';
import { validateChartStacks } from './chart-stacks.js';
import { chartCoordinates } from './chart-format.js';
import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
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
  if (spec.kind === 'heatmap') heatmapColorScale(spec);
  const rawSpec = plainRecord(record.spec, 'Chart spec');
  if (Object.hasOwn(rawSpec, 'annotations'))
    spec.annotations = validateAnnotations(requiredOwnValue(rawSpec, 'annotations', 'Chart'), spec);
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
  const orientation = kind === 'bar' ? optionalString(record, 'orientation', 'Bar chart') : undefined;
  if (orientation !== undefined && orientation !== 'vertical' && orientation !== 'horizontal')
    throw new ArtifactValidationError('Bar chart orientation must be vertical or horizontal.');
  const base: BaseChartSpec & { orientation?: 'vertical' | 'horizontal' } = {
    ...validateBaseChartSpec(record),
    ...(orientation === undefined ? {} : { orientation }),
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
    case 'errorbar':
    case 'band': {
      const xType = base.xType ?? 'value';
      const yType = numericAxisType(base.yType, 'Interval chart y axis');
      if (kind === 'band' && xType === 'category')
        throw new ArtifactValidationError('Band charts require a value, time, or log x axis.');
      const rawSeries = plainArray(requiredOwnValue(record, 'series', 'Interval chart'), 'Interval chart series');
      if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
      const ids = new Set<string>();
      let count = 0;
      const series = rawSeries.map((raw, index) => {
        const context = kind + ' chart series ' + (index + 1);
        const item = plainRecord(raw, context);
        const rawPoints = plainArray(requiredOwnValue(item, 'points', context), context + ' points');
        count += Math.max(1, rawPoints.length);
        if (count > outputArtifactLimits.chartDataItems) throw chartLimitError(count);
        let previous = -Infinity;
        const points = rawPoints.map((rawPoint, pointIndex): IntervalPoint => {
          const label = context + ' point ' + (pointIndex + 1);
          const tuple = fixedTuple(rawPoint, 4, label);
          const x = chartCoordinate(tuple[0], xType, label + ' x');
          const orderedX = xType === 'time' && typeof x === 'string' ? Date.parse(x) : Number(x);
          if (kind === 'band' && orderedX <= previous)
            throw new ArtifactValidationError(label + ' x must be strictly increasing.');
          previous = orderedX;
          if (tuple.slice(1).every((value) => value === null)) return [x, null, null, null];
          const center = numericCoordinate(tuple[1], yType, label + ' center');
          const lower = numericCoordinate(tuple[2], yType, label + ' lower');
          const upper = numericCoordinate(tuple[3], yType, label + ' upper');
          if (lower > center || center > upper)
            throw new ArtifactValidationError(label + ' requires lower <= center <= upper.');
          return [x, center, lower, upper];
        });
        return { ...validateSeriesPresentation(item, kind, index, ids), points };
      });
      return { ...base, kind, yType, series };
    }
    case 'field': {
      requireEffectiveAxis(base.xType, 'value', 'Field x axis');
      requireEffectiveAxis(base.yType, 'value', 'Field y axis');
      const edges = (key: string) => {
        const items = plainArray(requiredOwnValue(record, key, 'Field'), 'Field ' + key);
        if (items.length > outputArtifactLimits.chartDataItems + 1) throw chartLimitError(items.length - 1);
        const values = items.map((value, index) => finiteNumber(value, 'Field ' + key + ' boundary ' + (index + 1)));
        if (values.length === 1 || values.some((value, index) => index > 0 && value <= values[index - 1]))
          throw new ArtifactValidationError(
            'Field ' + key + ' must be empty or have at least two strictly increasing boundaries.'
          );
        return values;
      };
      const xEdges = edges('xEdges');
      const yEdges = edges('yEdges');
      const rows = plainArray(requiredOwnValue(record, 'values', 'Field'), 'Field values');
      if (xEdges.length === 0 || yEdges.length === 0) {
        if (xEdges.length || yEdges.length || rows.length)
          throw new ArtifactValidationError('Empty fields require empty xEdges, yEdges, and values.');
      }
      const width = Math.max(0, xEdges.length - 1);
      const height = Math.max(0, yEdges.length - 1);
      if (width * height > outputArtifactLimits.chartDataItems) throw chartLimitError(width * height);
      if (rows.length !== height) throw new ArtifactValidationError('Field values rows must match yEdges intervals.');
      const values = rows.map((row, index) => {
        const items = plainArray(row, 'Field row ' + (index + 1));
        if (items.length !== width)
          throw new ArtifactValidationError('Field row ' + (index + 1) + ' columns must match xEdges intervals.');
        return items.map((value) => (value === null ? null : finiteNumber(value, 'Field cell')));
      });
      return { ...base, kind, xType: 'value', yType: 'value', xEdges, yEdges, values };
    }
    case 'bubble': {
      const sizeMapping: BubbleSizeMapping = {};
      if (Object.hasOwn(record, 'sizeMapping')) {
        const size = plainRecord(requiredOwnValue(record, 'sizeMapping', 'Bubble'), 'Bubble sizeMapping');
        rejectUnknownStyleFields(size, ['maxValue', 'minPixels', 'maxPixels', 'scale'], 'Bubble sizeMapping');
        for (const field of ['maxValue', 'minPixels', 'maxPixels'] as const)
          if (Object.hasOwn(size, field))
            sizeMapping[field] = finiteNumber(
              requiredOwnValue(size, field, 'Bubble sizeMapping'),
              'Bubble sizeMapping ' + field
            );
        const scale = optionalString(size, 'scale', 'Bubble sizeMapping');
        if (scale !== undefined && scale !== 'area' && scale !== 'radius')
          throw new ArtifactValidationError('Bubble size scale must be area or radius.');
        if (scale !== undefined) sizeMapping.scale = scale;
        if (
          (sizeMapping.maxValue !== undefined && sizeMapping.maxValue <= 0) ||
          (sizeMapping.minPixels ?? 0) < 0 ||
          (sizeMapping.maxPixels ?? 40) > 100 ||
          (sizeMapping.minPixels ?? 0) >= (sizeMapping.maxPixels ?? 40)
        )
          throw new ArtifactValidationError(
            'Bubble sizeMapping requires positive maxValue and 0 <= minPixels < maxPixels <= 100.'
          );
      }
      let colorMapping: Extract<ChartSpec, { kind: 'bubble' }>['colorMapping'];
      if (Object.hasOwn(record, 'colorMapping')) {
        const color = plainRecord(requiredOwnValue(record, 'colorMapping', 'Bubble'), 'Bubble colorMapping');
        rejectUnknownStyleFields(color, ['min', 'max', 'palette'], 'Bubble colorMapping');
        const min = finiteNumber(requiredOwnValue(color, 'min', 'Bubble colorMapping'), 'Bubble colorMapping min');
        const max = finiteNumber(requiredOwnValue(color, 'max', 'Bubble colorMapping'), 'Bubble colorMapping max');
        if (min >= max) throw new ArtifactValidationError('Bubble colorMapping min must be smaller than max.');
        colorMapping = {
          min,
          max,
          ...(Object.hasOwn(color, 'palette')
            ? {
                palette: validateChartStyle(
                  { palette: requiredOwnValue(color, 'palette', 'Bubble colorMapping') },
                  'heatmap'
                ).palette
              }
            : {})
        };
      }
      const rawSeries = plainArray(requiredOwnValue(record, 'series', 'Bubble chart'), 'Bubble series');
      if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
      let count = 0;
      const ids = new Set<string>();
      const series = rawSeries.map((raw, index) => {
        const context = 'Bubble series ' + (index + 1);
        const item = plainRecord(raw, context);
        const rawPoints = plainArray(requiredOwnValue(item, 'points', context), context + ' points');
        count += Math.max(1, rawPoints.length);
        if (count > outputArtifactLimits.chartDataItems) throw chartLimitError(count);
        const points = rawPoints.map((rawPoint, pointIndex): BubblePoint => {
          const label = context + ' point ' + (pointIndex + 1);
          const tuple = plainArray(rawPoint, label);
          if (tuple.length !== 3 && tuple.length !== 4)
            throw new ArtifactValidationError(label + ' requires x, y, size and optional color.');
          const x = chartCoordinate(tuple[0], base.xType ?? 'value', label + ' x');
          const y = chartCoordinate(tuple[1], base.yType ?? 'value', label + ' y');
          const size = finiteNumber(tuple[2], label + ' size');
          if (size < 0) throw new ArtifactValidationError(label + ' size must not be negative.');
          if (tuple.length === 3) return [x, y, size];
          if (tuple[3] === null) return [x, y, size, null];
          const color = finiteNumber(tuple[3], label + ' color');
          if (!colorMapping) throw new ArtifactValidationError(label + ' color requires an explicit colorMapping.');
          return [x, y, size, color];
        });
        return { ...validateSeriesPresentation(item, kind, index, ids), points };
      });
      return {
        ...base,
        kind,
        series,
        ...(Object.hasOwn(record, 'sizeMapping') ? { sizeMapping } : {}),
        ...(colorMapping ? { colorMapping } : {})
      };
    }
    case 'boxplot': {
      requireEffectiveAxis(base.xType, 'category', 'Boxplot x axis');
      const yType = numericAxisType(base.yType, 'Boxplot y axis');
      const categories = stringArray(requiredOwnValue(record, 'categories', 'Boxplot'), 'Boxplot categories');
      const rawSeries = plainArray(requiredOwnValue(record, 'series', 'Boxplot'), 'Boxplot series');
      if (rawSeries.length > outputArtifactLimits.chartDataItems) throw chartLimitError(rawSeries.length);
      let count = 0;
      const ids = new Set<string>();
      const series = rawSeries.map((raw, index) => {
        const context = 'Boxplot series ' + (index + 1);
        const item = plainRecord(raw, context);
        const rawValues = plainArray(requiredOwnValue(item, 'values', context), context + ' values');
        count += Math.max(1, rawValues.length);
        if (count > outputArtifactLimits.chartDataItems) throw chartLimitError(count);
        if (rawValues.length !== categories.length)
          throw new ArtifactValidationError(context + ' values must match categories.');
        const values = rawValues.map((rawValue, valueIndex): BoxplotValue | null => {
          if (rawValue === null) return null;
          const label = context + ' value ' + (valueIndex + 1);
          const tuple = fixedTuple(rawValue, 5, label).map((value) => numericCoordinate(value, yType, label));
          if (tuple.some((value, index) => index > 0 && value < tuple[index - 1]))
            throw new ArtifactValidationError(label + ' requires min <= q1 <= median <= q3 <= max.');
          return [tuple[0], tuple[1], tuple[2], tuple[3], tuple[4]];
        });
        return { ...validateSeriesPresentation(item, kind, index, ids), values };
      });
      return { ...base, kind, xType: 'category', yType, categories, series };
    }
    case 'bar': {
      const horizontal = orientation === 'horizontal';
      requireEffectiveAxis(horizontal ? base.yType : base.xType, 'category', 'Bar chart category axis');
      const valueType = numericAxisType(horizontal ? base.xType : base.yType, 'Bar chart value axis');
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
          return numericCoordinate(item, valueType, `Bar chart series ${seriesIndex + 1} value ${valueIndex + 1}`);
        });
        if (validatedValues.length !== categories.length) {
          throw new ArtifactValidationError(
            `Bar chart series ${seriesIndex + 1} has ${validatedValues.length} values; expected ${categories.length}.`
          );
        }
        dataItems += validatedValues.length;
        return { ...validateSeriesPresentation(seriesRecord, kind, seriesIndex, ids), values: validatedValues };
      });
      return { ...base, kind, categories, series };
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
      const colorScale = optionalString(record, 'colorScale', 'Heatmap');
      if (colorScale !== undefined && colorScale !== 'sequential' && colorScale !== 'diverging')
        throw new ArtifactValidationError('Heatmap colorScale must be sequential or diverging.');
      const color: Partial<Extract<ChartSpec, { kind: 'heatmap' }>> = {};
      if (colorScale !== undefined) color.colorScale = colorScale;
      for (const field of ['colorMin', 'colorMax', 'center'] as const)
        if (Object.hasOwn(record, field))
          color[field] = finiteNumber(requiredOwnValue(record, field, 'Heatmap'), 'Heatmap ' + field);
      if (color.center !== undefined && colorScale !== 'diverging')
        throw new ArtifactValidationError('Heatmap center requires a diverging colorScale.');
      if (colorScale === 'diverging')
        for (const colors of Object.values(base.style?.palette ?? {}))
          if (colors.length < 3 || colors.length % 2 === 0)
            throw new ArtifactValidationError('Diverging palettes require an odd number of at least three colors.');
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
        ...color,
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
  const line = ['line', 'area', 'errorbar', 'band'].includes(kind);
  rejectUnknownStyleFields(
    record,
    [
      'palette',
      'renderer',
      'xFormat',
      'yFormat',
      ...(['heatmap', 'bubble', 'field'].includes(kind) ? ['valueFormat'] : []),
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
      const minimum = kind === 'heatmap' || kind === 'field' ? 2 : 1;
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

function validateChartRanges(spec: BaseChartSpec & { kind: string; orientation?: 'vertical' | 'horizontal' }): void {
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
      axis === (spec.kind === 'bar' && spec.orientation === 'horizontal' ? 'x' : 'y') &&
      type === 'value' &&
      ['bar', 'histogram', 'area'].includes(spec.kind) &&
      (zero === false || (min !== undefined && min > 0) || (max !== undefined && max < 0))
    )
      throw new ArtifactValidationError(`Chart ${spec.kind} value ${axis} range must include zero.`);
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
    [
      'color',
      ...(['line', 'area', 'scatter', 'bubble'].includes(kind) ? ['symbol'] : []),
      ...(line ? ['lineType', 'smooth', 'step', 'showSymbol'] : [])
    ],
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

function validateAnnotations(value: unknown, spec: ChartSpec): ChartAnnotation[] {
  const annotations = plainArray(value, 'Chart annotations');
  if (annotations.length > outputArtifactLimits.chartAnnotations)
    throw new ArtifactValidationError('Chart annotations exceed the 100 item limit.');
  const coordinates = chartCoordinates(spec);
  const categoryNames = {
    x: chartAxisType(spec, 'x') === 'category' ? [...new Set(coordinates.x.map(String))] : [],
    y: chartAxisType(spec, 'y') === 'category' ? [...new Set(coordinates.y.map(String))] : []
  };
  return annotations.map((raw, index): ChartAnnotation => {
    const context = 'Chart annotation ' + (index + 1);
    const item = plainRecord(raw, context);
    const kind = requiredString(item, 'kind', context);
    const axis = requiredString(item, 'axis', context);
    if (axis !== 'x' && axis !== 'y') throw new ArtifactValidationError(context + ' axis must be x or y.');
    if (kind !== 'line' && kind !== 'range')
      throw new ArtifactValidationError(context + ' kind must be line or range.');
    rejectUnknownStyleFields(
      item,
      ['kind', 'axis', 'label', 'style', ...(kind === 'line' ? ['value'] : ['from', 'to'])],
      context
    );
    const label = optionalString(item, 'label', context);
    if (
      label !== undefined &&
      (utf8ByteLength(label) > outputArtifactLimits.bytesPerAnnotationLabel || /[\r\n]/u.test(label))
    )
      throw new ArtifactValidationError(context + ' label must be one line within 256 UTF-8 bytes.');
    const type = chartAxisType(spec, axis);
    const categories = categoryNames[axis];
    const coordinate = (key: string) => {
      const value = requiredOwnValue(item, key, context);
      if (type !== 'category') return chartCoordinate(value, type, context + ' ' + key);
      const category = typeof value === 'number' && Number.isSafeInteger(value) ? categories[value] : value;
      if (typeof category !== 'string' || !categories.includes(category))
        throw new ArtifactValidationError(context + ' ' + key + ' must reference an existing category.');
      return category;
    };
    const style = Object.hasOwn(item, 'style')
      ? plainRecord(requiredOwnValue(item, 'style', context), context + ' style')
      : {};
    rejectUnknownStyleFields(
      style,
      kind === 'line' ? ['color', 'width', 'lineType'] : ['color', 'opacity'],
      context + ' style'
    );
    const color = Object.hasOwn(style, 'color')
      ? validateChartColor(requiredOwnValue(style, 'color', context), context)
      : undefined;
    const common = { axis, ...(label === undefined ? {} : { label }) };
    const colorStyle = color === undefined ? {} : { color };
    if (kind === 'line') {
      const lineType = optionalString(style, 'lineType', context);
      if (lineType !== undefined && !['solid', 'dashed', 'dotted'].includes(lineType))
        throw new ArtifactValidationError(context + ' lineType is unsupported.');
      const width = Object.hasOwn(style, 'width')
        ? finiteNumber(requiredOwnValue(style, 'width', context), context + ' width')
        : undefined;
      if (width !== undefined && (width < 0.5 || width > 4))
        throw new ArtifactValidationError(context + ' width must be within 0.5–4.');
      return {
        ...common,
        axis,
        kind,
        value: coordinate('value'),
        style: {
          ...colorStyle,
          ...(width === undefined ? {} : { width }),
          ...(lineType === undefined ? {} : { lineType: lineType as 'solid' | 'dashed' | 'dotted' })
        }
      };
    }
    const from = coordinate('from');
    const to = coordinate('to');
    const order = (value: number | string) =>
      type === 'category'
        ? categories.indexOf(String(value))
        : type === 'time' && typeof value === 'string'
          ? Date.parse(value)
          : Number(value);
    if (order(from) >= order(to)) throw new ArtifactValidationError(context + ' from must precede to.');
    const opacity = Object.hasOwn(style, 'opacity')
      ? finiteNumber(requiredOwnValue(style, 'opacity', context), context + ' opacity')
      : undefined;
    if (opacity !== undefined && (opacity < 0 || opacity > 1))
      throw new ArtifactValidationError(context + ' opacity must be within 0–1.');
    return { ...common, axis, kind, from, to, style: { ...colorStyle, ...(opacity === undefined ? {} : { opacity }) } };
  });
}
