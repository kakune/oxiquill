import type {
  ChartArtifact,
  CellExecutionResult,
  OutputArtifact,
  PlotSpec,
  RawCellExecutionResult,
  TextArtifact
} from './types.js';
import {
  validateOutputArtifacts,
  type ValidatedArtifactResult,
  type ValidatedOutputArtifact
} from './output-artifact-validation.js';

export interface NormalizedCellExecutionResult extends CellExecutionResult {
  outputResults: readonly ValidatedArtifactResult[];
}

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

export function normalizeCellExecutionResult(result: RawCellExecutionResult): NormalizedCellExecutionResult {
  const rawOutputs = ownDataField(result, 'outputs');
  const outputCandidates = rawOutputs.present
    ? Array.isArray(rawOutputs.value)
      ? rawOutputs.value
      : [rawOutputs.value]
    : legacyResultToOutputCandidates(result);
  const outputResults = validateOutputArtifacts(outputCandidates);
  const outputs = outputResults.flatMap((output) =>
    output.status === 'valid' ? [publicOutputArtifact(output.artifact)] : []
  );
  const legacy = outputsToLegacyResult(outputs);

  return {
    ...legacy,
    outputs,
    outputResults
  };
}

function legacyResultToOutputCandidates(result: RawCellExecutionResult): readonly unknown[] {
  const stdout = ownDataField(result, 'stdout').value;
  const stderr = ownDataField(result, 'stderr').value;
  const value = ownDataField(result, 'value');
  const plots = ownDataField(result, 'plots').value;
  return [
    typeof stdout === 'string' && stdout.length > 0 ? [{ kind: 'text', stream: 'stdout', content: stdout }] : [],
    typeof stderr === 'string' && stderr.length > 0 ? [{ kind: 'text', stream: 'stderr', content: stderr }] : [],
    value.present && value.value != null && value.value !== '' ? [{ kind: 'json', value: value.value }] : [],
    ...(Array.isArray(plots) ? plots.map((plot) => [legacyPlotCandidate(plot)]) : [])
  ].flat();
}

function legacyPlotCandidate(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const kind = ownDataField(record, 'kind').value;
  const xLabel = ownDataField(record, 'x_label').value;
  const yLabel = ownDataField(record, 'y_label').value;
  const points = ownDataField(record, 'points').value;
  return {
    kind: 'chart',
    spec: {
      kind,
      xLabel,
      yLabel,
      xType: 'value',
      yType: 'value',
      tooltip: true,
      dataZoom: true,
      series: [{ points }]
    }
  };
}

function ownDataField(record: object, key: PropertyKey): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? { present: true, value: descriptor.value }
    : { present: descriptor != null, value: undefined };
}

function publicOutputArtifact(artifact: ValidatedOutputArtifact): OutputArtifact {
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

export function isOutputArtifact(value: unknown): value is OutputArtifact {
  return validateOutputArtifacts([value])[0]?.status === 'valid';
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
