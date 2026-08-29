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
  isRunning,
  labels,
  outputId,
  result,
  runMode
}: {
  cellTitle: string;
  error?: string;
  isRunning: boolean;
  labels: RuntimeLabels;
  outputId: string;
  result?: CellExecutionResult | NormalizedCellExecutionResult;
  runMode: CellManifest['run'];
}) {
  const outputResults = result
    ? 'outputResults' in result
      ? result.outputResults
      : normalizeCellExecutionResult(result).outputResults
    : undefined;
  const liveMessage = isRunning
    ? labels.cellRunningAnnouncement
    : result
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
      {error ? (
        <p class="error-state" role="alert">
          {labels.executionErrorLabel} <span>{labels.diagnosticDetail(error)}</span>
        </p>
      ) : isRunning ? (
        <p class="empty-state">{labels.runningCell}</p>
      ) : !result ? (
        <p class="empty-state">{idleOutputMessage(runMode, labels)}</p>
      ) : outputResults?.length ? (
        <div class="doc-cell__outputs">
          <OutputRenderer idPrefix={outputId} labels={labels} outputs={outputResults} />
        </div>
      ) : (
        <p class="empty-state">{labels.cellCompletedWithoutOutput}</p>
      )}
    </div>
  );
}
