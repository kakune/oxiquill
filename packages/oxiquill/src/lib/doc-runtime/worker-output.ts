import { outputArtifactLimits, utf8ByteLength } from './output-limits.mjs';
import { normalizeCellExecutionResult, outputsToLegacyResult } from './output-artifacts.js';
import type { ValidatedArtifactResult, ValidatedOutputArtifact } from './output-artifact-validation.js';
import type { OutputArtifact, RawCellExecutionResult } from './types.js';

type ProducerErrorArtifact = {
  kind: '__oxiquill_error';
  message: string;
};

type WorkerOutputCandidate = OutputArtifact | ProducerErrorArtifact;

const responseLimitArtifact: ProducerErrorArtifact = {
  kind: '__oxiquill_error',
  message: `Worker response exceeded ${outputArtifactLimits.workerResponseBytes} bytes; later artifacts were omitted.`
};

export function boundWorkerResult(result: RawCellExecutionResult): RawCellExecutionResult {
  const normalized = normalizeCellExecutionResult(result);
  const candidates = capArtifactCount(normalized.outputResults.map(workerOutputCandidate));
  const complete = workerResultFromCandidates(candidates);
  if (workerResultByteLength(complete) <= outputArtifactLimits.workerResponseBytes) return complete;

  let low = 0;
  let high = Math.min(candidates.length, outputArtifactLimits.artifactsPerRun - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = workerResultFromCandidates([...candidates.slice(0, middle), responseLimitArtifact]);
    if (workerResultByteLength(candidate) <= outputArtifactLimits.workerResponseBytes) low = middle;
    else high = middle - 1;
  }

  return workerResultFromCandidates([...candidates.slice(0, low), responseLimitArtifact]);
}

export function workerResultByteLength(result: RawCellExecutionResult): number {
  return utf8ByteLength(JSON.stringify(result));
}

function capArtifactCount(candidates: readonly WorkerOutputCandidate[]): readonly WorkerOutputCandidate[] {
  if (candidates.length <= outputArtifactLimits.artifactsPerRun) return candidates;
  return [...candidates.slice(0, outputArtifactLimits.artifactsPerRun - 1), candidates.at(-1) ?? responseLimitArtifact];
}

function workerOutputCandidate(result: ValidatedArtifactResult): WorkerOutputCandidate {
  return result.status === 'valid'
    ? publicOutputArtifact(result.artifact)
    : { kind: '__oxiquill_error', message: result.message };
}

function workerResultFromCandidates(candidates: readonly WorkerOutputCandidate[]): RawCellExecutionResult {
  const outputs = candidates.filter((candidate): candidate is OutputArtifact => candidate.kind !== '__oxiquill_error');
  return {
    ...outputsToLegacyResult(outputs),
    outputs: candidates
  };
}

function publicOutputArtifact(artifact: ValidatedOutputArtifact): OutputArtifact {
  if (artifact.kind === 'json') {
    const output = { ...artifact };
    Reflect.deleteProperty(output, 'formattedValue');
    return output;
  }
  if (artifact.kind === 'image') {
    const output = { ...artifact };
    Reflect.deleteProperty(output, 'source');
    return output;
  }
  return artifact;
}
