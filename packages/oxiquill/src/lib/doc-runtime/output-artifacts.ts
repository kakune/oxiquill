import { validateCellExports } from './cell-exports.js';
import type { CellExecutionResult, OutputArtifact, CellManifest } from './types.js';
import {
  publicOutputArtifact,
  validateOutputArtifacts,
  type ValidatedArtifactResult
} from './output-artifact-validation.js';

export interface NormalizedCellExecutionResult extends CellExecutionResult {
  outputResults: readonly ValidatedArtifactResult[];
}

export function normalizeCellExecutionResult(
  result: unknown,
  producer?: Pick<CellManifest, 'title' | 'exports'>
): NormalizedCellExecutionResult {
  const outputs = resultOutputs(result);
  const outputResults = validateOutputArtifacts(
    outputs ?? [
      {
        kind: '__oxiquill_error',
        message:
          'Cell execution results require an outputs array. Regenerate the runtime with oxiquill docgen --wasm dev.'
      }
    ]
  );
  const exports = validateCellExports(resultField(result, 'exports'), producer);
  return {
    ...(exports ? { exports } : {}),
    outputs: outputResults.flatMap((output) =>
      output.status === 'valid' ? [publicOutputArtifact(output.artifact)] : []
    ),
    outputResults
  };
}

function resultOutputs(result: unknown): readonly unknown[] | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(result, 'outputs');
    return descriptor && Object.hasOwn(descriptor, 'value') && Array.isArray(descriptor.value)
      ? (descriptor.value as readonly unknown[])
      : undefined;
  } catch {
    return undefined;
  }
}

export function isOutputArtifact(value: unknown): value is OutputArtifact {
  return validateOutputArtifacts([value])[0]?.status === 'valid';
}

function resultField(result: unknown, name: string): unknown {
  if (typeof result !== 'object' || result === null) return undefined;
  try {
    return Object.getOwnPropertyDescriptor(result, name)?.value;
  } catch {
    return undefined;
  }
}
