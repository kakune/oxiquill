import { legacyResultToOutputs } from './output-artifacts.js';
import type { RawCellExecutionResult } from './types.js';

export function createPythonCellResult({
  displayOutputs,
  plots,
  stderr,
  stdout,
  value
}: {
  displayOutputs: readonly unknown[];
  plots: NonNullable<RawCellExecutionResult['plots']>;
  stderr: string;
  stdout: string;
  value: unknown;
}): RawCellExecutionResult {
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

export function toOutputArtifacts(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
