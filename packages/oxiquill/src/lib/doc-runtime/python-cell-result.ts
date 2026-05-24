import {
  isOutputArtifact,
  legacyResultToOutputs
} from './output-artifacts';
import type {
  CellExecutionResult,
  OutputArtifact
} from './types';

export function createPythonCellResult({
  displayOutputs,
  plots,
  stderr,
  stdout,
  value
}: {
  displayOutputs: readonly OutputArtifact[];
  plots: CellExecutionResult['plots'];
  stderr: string;
  stdout: string;
  value: unknown;
}): CellExecutionResult {
  const streamOutputs = legacyResultToOutputs({ stdout, stderr, plots: [] });
  const valueOutputs = legacyResultToOutputs({ value, plots: [] });

  return {
    stdout,
    stderr,
    value,
    plots,
    outputs: [...streamOutputs, ...displayOutputs, ...valueOutputs]
  };
}

export function toOutputArtifacts(value: unknown): readonly OutputArtifact[] {
  return Array.isArray(value) ? value.filter(isOutputArtifact) : [];
}
