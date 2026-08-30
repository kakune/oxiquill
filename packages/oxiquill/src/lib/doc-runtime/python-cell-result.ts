import { legacyResultToOutputs } from './output-artifacts.js';
import type { RawCellExecutionResult } from './types.js';

export function createPythonCellResult({
  displayOutputs,
  plots,
  stderr,
  stderrTruncated = false,
  stdout,
  stdoutTruncated = false,
  value
}: {
  displayOutputs: readonly unknown[];
  plots: NonNullable<RawCellExecutionResult['plots']>;
  stderr: string;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutTruncated?: boolean;
  value: unknown;
}): RawCellExecutionResult {
  const streamOutputs = legacyResultToOutputs({ stdout, stderr, plots: [] }).map((output) =>
    output.kind === 'text' &&
    ((output.stream === 'stdout' && stdoutTruncated) || (output.stream === 'stderr' && stderrTruncated))
      ? { ...output, truncated: true }
      : output
  );
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
