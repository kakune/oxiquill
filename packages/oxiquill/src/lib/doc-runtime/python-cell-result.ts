import type { RawCellExecutionResult, TextArtifact } from './types.js';

export function createPythonCellResult({
  displayOutputs,
  stderr,
  stderrTruncated = false,
  stdout,
  stdoutTruncated = false,
  value
}: {
  displayOutputs: readonly unknown[];
  stderr: string;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutTruncated?: boolean;
  value: unknown;
}): RawCellExecutionResult {
  const streamOutputs: TextArtifact[] = [
    ...(stdout
      ? [
          {
            kind: 'text' as const,
            stream: 'stdout' as const,
            content: stdout,
            ...(stdoutTruncated ? { truncated: true } : {})
          }
        ]
      : []),
    ...(stderr
      ? [
          {
            kind: 'text' as const,
            stream: 'stderr' as const,
            content: stderr,
            ...(stderrTruncated ? { truncated: true } : {})
          }
        ]
      : [])
  ];
  return {
    outputs: [...streamOutputs, ...displayOutputs, ...(value != null && value !== '' ? [{ kind: 'json', value }] : [])]
  };
}

export function toOutputArtifacts(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
