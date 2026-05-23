import type {
  ChartArtifact,
  ChartSpec,
  CellExecutionResult,
  ImageArtifact,
  OutputArtifact,
  OutputLimits,
  PlotSpec,
  RawCellExecutionResult,
  TableArtifact,
  TableColumn,
  TextArtifact
} from './types';

export const defaultOutputLimits: OutputLimits = {
  maxTextBytes: 200_000,
  maxJsonBytes: 500_000,
  maxJsonDepth: 32,
  maxTableRows: 1_000,
  maxImageBytes: 2_000_000,
  maxHtmlBytes: 500_000
};

const artifactKinds = new Set(['text', 'json', 'table', 'chart', 'image', 'html']);
const artifactStreams = new Set(['stdout', 'stderr', 'display']);
const tableColumnTypes = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'null',
  'unknown'
]);
const chartKinds = new Set(['line', 'scatter', 'bar', 'histogram', 'area', 'heatmap']);
const imageMimes = new Set(['image/png', 'image/jpeg', 'image/svg+xml']);

export function legacyResultToOutputs(result: RawCellExecutionResult): readonly OutputArtifact[] {
  return [
    result.stdout ? [{ kind: 'text', stream: 'stdout', content: result.stdout } satisfies TextArtifact] : [],
    result.stderr ? [{ kind: 'text', stream: 'stderr', content: result.stderr } satisfies TextArtifact] : [],
    result.value != null && result.value !== '' ? [{ kind: 'json', value: result.value } satisfies OutputArtifact] : [],
    ...(result.plots ?? []).map((plot) => [legacyPlotToChartArtifact(plot)])
  ].flat();
}

export function outputsToLegacyResult(outputs: readonly OutputArtifact[]): CellExecutionResult {
  const stdout = joinTextArtifacts(outputs, 'stdout');
  const stderr = joinTextArtifacts(outputs, 'stderr');
  const jsonValues = outputs.filter((output) => output.kind === 'json').map((output) => output.value);

  return {
    stdout,
    ...(stderr ? { stderr } : {}),
    ...(jsonValues.length > 0 ? { value: jsonValues.at(-1) } : {}),
    plots: outputs.flatMap(chartArtifactToLegacyPlot),
    outputs
  };
}

export function normalizeCellExecutionResult(result: RawCellExecutionResult): CellExecutionResult {
  const explicitOutputs = Array.isArray(result.outputs)
    ? result.outputs.filter(isOutputArtifact)
    : [];
  const outputs = explicitOutputs.length > 0 ? explicitOutputs : legacyResultToOutputs(result);
  const legacy = outputsToLegacyResult(outputs);

  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : legacy.stdout,
    ...(typeof result.stderr === 'string' ? { stderr: result.stderr } : legacy.stderr ? { stderr: legacy.stderr } : {}),
    ...(Object.hasOwn(result, 'value') ? { value: result.value } : Object.hasOwn(legacy, 'value') ? { value: legacy.value } : {}),
    plots: Array.isArray(result.plots) ? result.plots : legacy.plots,
    outputs
  };
}

export function isOutputArtifact(value: unknown): value is OutputArtifact {
  if (!isRecord(value) || !artifactKinds.has(value.kind as string) || !hasValidBaseArtifact(value)) {
    return false;
  }

  switch (value.kind) {
    case 'text':
      return artifactStreams.has(value.stream as string) && typeof value.content === 'string';
    case 'json':
      return Object.hasOwn(value, 'value');
    case 'table':
      return isTableArtifact(value);
    case 'chart':
      return isChartSpec(value.spec);
    case 'image':
      return isImageArtifact(value);
    case 'html':
      return typeof value.html === 'string' && value.sandboxed === true;
    default:
      return false;
  }
}

export function withDefaultOutputLimits(overrides: Partial<OutputLimits> = {}): OutputLimits {
  return { ...defaultOutputLimits, ...overrides };
}

function legacyPlotToChartArtifact(plot: PlotSpec): ChartArtifact {
  return {
    kind: 'chart',
    spec: {
      kind: 'line',
      xLabel: plot.x_label,
      yLabel: plot.y_label,
      xType: 'value',
      yType: 'value',
      tooltip: true,
      dataZoom: true,
      series: [{ points: plot.points }]
    }
  };
}

function chartArtifactToLegacyPlot(output: OutputArtifact): PlotSpec[] {
  if (output.kind !== 'chart' || output.spec.kind !== 'line' || output.spec.series.length !== 1) {
    return [];
  }

  const points = output.spec.series[0]?.points;
  if (!points.every((point) => point.every((value) => typeof value === 'number'))) {
    return [];
  }

  return [
    {
      kind: 'line',
      x_label: output.spec.xLabel ?? '',
      y_label: output.spec.yLabel ?? '',
      points: points as readonly [number, number][]
    }
  ];
}

function joinTextArtifacts(outputs: readonly OutputArtifact[], stream: TextArtifact['stream']): string {
  return outputs
    .filter((output): output is TextArtifact => output.kind === 'text' && output.stream === stream)
    .map((output) => output.content)
    .filter((content) => content.length > 0)
    .join('\n');
}

function hasValidBaseArtifact(value: Record<string, unknown>): boolean {
  return (
    optionalString(value.id) &&
    optionalString(value.title) &&
    optionalString(value.caption) &&
    (typeof value.truncated === 'boolean' || value.truncated == null)
  );
}

function isTableArtifact(value: unknown): value is TableArtifact {
  if (!isRecord(value)) return false;

  return (
    Array.isArray(value.columns) &&
    value.columns.every(isTableColumn) &&
    Array.isArray(value.rows) &&
    value.rows.every(Array.isArray) &&
    (typeof value.rowCount === 'number' || value.rowCount == null)
  );
}

function isTableColumn(value: unknown): value is TableColumn {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    (value.type == null || tableColumnTypes.has(value.type as string))
  );
}

function isChartSpec(value: unknown): value is ChartSpec {
  return isRecord(value) && chartKinds.has(value.kind as string);
}

function isImageArtifact(value: unknown): value is ImageArtifact {
  if (!isRecord(value)) return false;

  return (
    imageMimes.has(value.mime as string) &&
    typeof value.data === 'string' &&
    optionalString(value.alt)
  );
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
