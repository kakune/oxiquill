import { idleOutputMessage, labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model.js';
import {
  normalizeCellExecutionResult,
  type NormalizedCellExecutionResult
} from '../../lib/doc-runtime/output-artifacts.js';
import type { CellExecutionResult, CellManifest } from '../../lib/doc-runtime/types.js';
import OutputRenderer from './OutputRenderer.js';

type RuntimeLabels = ReturnType<typeof labelsForLanguage>;

export function CellOutput({
  cellTitle,
  error,
  isComplete = true,
  isRunning,
  labels,
  outputId,
  result,
  retry,
  canRetry = true,
  runMode
}: {
  cellTitle: string;
  error?: string;
  isComplete?: boolean;
  isRunning: boolean;
  labels: RuntimeLabels;
  outputId: string;
  result?: CellExecutionResult | NormalizedCellExecutionResult;
  retry?: () => void;
  canRetry?: boolean;
  runMode: CellManifest['run'];
}) {
  const outputResults = result
    ? 'outputResults' in result
      ? result.outputResults
      : normalizeCellExecutionResult(result).outputResults
    : undefined;
  const liveMessage = isRunning
    ? labels.cellRunningAnnouncement
    : result && isComplete && error === undefined
      ? outputResults?.length
        ? labels.cellCompleted
        : labels.cellCompletedWithoutOutput
      : '';

  return (
    <div
      id={outputId}
      class="doc-cell__output-region"
      aria-busy={isRunning}
      aria-label={labels.cellOutput(cellTitle)}
      role="region"
    >
      <p class="doc-visually-hidden" aria-atomic="true" aria-live="polite" role="status">
        {liveMessage}
      </p>
      {error !== undefined ? (
        <div class="doc-cell__error">
          <p class="error-state" role="alert">
            {labels.executionErrorLabel} <span>{labels.diagnosticDetail(error)}</span>
          </p>
          {retry ? (
            <button type="button" onClick={retry} disabled={isRunning || !canRetry}>
              {labels.cellRetry}
            </button>
          ) : null}
        </div>
      ) : null}
      {result ? (
        <div class="doc-cell__outputs" key="outputs">
          <OutputRenderer idPrefix={outputId} labels={labels} outputs={outputResults ?? []} resultIdentity={result} />
          {outputResults?.length ? null : <p class="empty-state">{labels.cellCompletedWithoutOutput}</p>}
        </div>
      ) : error !== undefined ? null : isRunning ? (
        <p class="empty-state">{labels.runningCell}</p>
      ) : (
        <p class="empty-state">{idleOutputMessage(runMode, labels)}</p>
      )}
      {result && isRunning ? (
        <span class="doc-cell__updating" aria-hidden="true">
          {labels.cellUpdating}
        </span>
      ) : null}
    </div>
  );
}
