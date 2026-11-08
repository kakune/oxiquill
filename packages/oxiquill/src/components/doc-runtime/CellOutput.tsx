import type { UpstreamFailure } from '../../lib/doc-runtime/page-cell-store.js';
import { useLayoutEffect, useMemo, useState } from 'preact/hooks';
import { idleOutputMessage, labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model.js';
import {
  normalizeCellExecutionResult,
  type NormalizedCellExecutionResult
} from '../../lib/doc-runtime/output-artifacts.js';
import type { CellExecutionResult, CellManifest, OutputLayout } from '../../lib/doc-runtime/types.js';
import OutputRenderer from './OutputRenderer.js';

type RuntimeLabels = ReturnType<typeof labelsForLanguage>;

export function CellOutput({
  cellTitle,
  reused = false,
  upstreamChanged = false,
  upstreamFailure,
  error,
  isComplete = true,
  isStale = false,
  isRunning,
  isPreparing = false,
  labels,
  outputId,
  outputLayout = 'stack',
  result,
  partialResult,
  retry,
  canRetry = true,
  runMode
}: {
  cellTitle: string;
  reused?: boolean;
  upstreamChanged?: boolean;
  upstreamFailure?: UpstreamFailure;
  error?: string;
  isComplete?: boolean;
  isStale?: boolean;
  isRunning: boolean;
  isPreparing?: boolean;
  labels: RuntimeLabels;
  outputId: string;
  outputLayout?: OutputLayout;
  result?: CellExecutionResult | NormalizedCellExecutionResult;
  partialResult?: NormalizedCellExecutionResult;
  retry?: () => void;
  canRetry?: boolean;
  runMode: CellManifest['run'];
}) {
  const sceneIdentity = useMemo(() => ({}), [outputId]);
  const outputResults = result
    ? 'outputResults' in result
      ? result.outputResults
      : normalizeCellExecutionResult(result).outputResults
    : undefined;
  const liveMessage = isRunning
    ? isPreparing
      ? labels.pythonPreparing
      : labels.cellRunningAnnouncement
    : result && isComplete && !isStale && error === undefined
      ? outputResults?.length
        ? labels.cellCompleted
        : labels.cellCompletedWithoutOutput
      : '';

  const outcome = outputResults?.find((output) => output.status === 'valid' && output.artifact.kind === 'outcome');
  // Announce an outcome when its content changes, not when an identical result is republished.
  const outcomeKey =
    outcome?.status === 'valid' && outcome.artifact.kind === 'outcome'
      ? JSON.stringify([outcome.artifact.state, outcome.artifact.label])
      : '';
  const [outcomeAnnouncement, setOutcomeAnnouncement] = useState('');
  useLayoutEffect(() => {
    setOutcomeAnnouncement('');
    if (
      !isComplete ||
      isRunning ||
      isStale ||
      error !== undefined ||
      outcome?.status !== 'valid' ||
      outcome.artifact.kind !== 'outcome'
    )
      return;
    const artifact = outcome.artifact;
    const timer = setTimeout(
      () => setOutcomeAnnouncement(labels.outcomeAnnouncement(artifact.state, artifact.label)),
      0
    );
    return () => clearTimeout(timer);
  }, [outcomeKey, isComplete, isRunning, isStale, error, labels]);
  const showReused = reused && isComplete && !isStale && !isRunning;

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
      {/* Live regions stay mounted so that changes to their text are announced. */}
      <p class="doc-visually-hidden" aria-atomic="true" aria-live="polite" role="status">
        {outcomeAnnouncement}
      </p>
      {/* Run status overlays the top of the outputs, so editing inputs and rerunning never moves
          charts, tables, or other retained output. */}
      <div class="doc-cell__status">
        {result && isRunning ? (
          <span class="doc-cell__updating" aria-hidden="true">
            {labels.cellUpdating}
          </span>
        ) : null}
        {result && isStale ? (
          <p class="doc-cell__stale" role="note">
            {labels.previousInputsOutput}
          </p>
        ) : null}
        {upstreamChanged ? (
          <p class="doc-cell__stale" role="note">
            {labels.upstreamChanged}
          </p>
        ) : null}
        <p class={showReused ? 'doc-cell__reused' : 'doc-visually-hidden'} role="status">
          {showReused ? labels.reusedResult : ''}
        </p>
      </div>
      {error !== undefined ? (
        <div class="doc-cell__error">
          <p class="error-state" role="alert">
            {labels.executionErrorLabel}{' '}
            {upstreamFailure ? (
              <span>
                <a href={`#doc-cell-${upstreamFailure.id}-title`}>{labels.upstreamFailed(upstreamFailure.title)}</a>{' '}
                {labels.diagnosticDetail(upstreamFailure.diagnostic)}
              </span>
            ) : (
              <span>{labels.diagnosticDetail(error)}</span>
            )}
          </p>
          {retry ? (
            <button type="button" onClick={retry} disabled={isRunning || !canRetry}>
              {labels.cellRetry}
            </button>
          ) : null}
        </div>
      ) : null}
      {partialResult ? (
        <section aria-label={labels.failedOutput} data-testid="failed-output">
          <p>{labels.failedOutput}</p>
          <OutputRenderer
            idPrefix={`${outputId}-failed`}
            labels={labels}
            outputs={partialResult.outputResults.filter(
              (output) => output.status !== 'valid' || output.artifact.kind !== 'outcome'
            )}
            resultIdentity={partialResult}
          />
        </section>
      ) : null}
      {result ? (
        <div class="doc-cell__retained-output" data-stale={isStale ? 'true' : undefined} key="outputs">
          <div class="doc-cell__outputs" data-layout={outputLayout === 'columns' ? 'columns' : undefined}>
            {error !== undefined ? <p>{labels.previousSuccessfulOutput}</p> : null}
            <OutputRenderer
              idPrefix={outputId}
              labels={labels}
              outputs={outputResults ?? []}
              resultIdentity={result}
              sceneIdentity={sceneIdentity}
            />
            {outputResults?.length ? null : <p class="empty-state">{labels.cellCompletedWithoutOutput}</p>}
          </div>
        </div>
      ) : error !== undefined ? null : isRunning ? (
        <p class="empty-state">{isPreparing ? labels.pythonPreparing : labels.runningCell}</p>
      ) : (
        <p class="empty-state">{idleOutputMessage(runMode, labels)}</p>
      )}
    </div>
  );
}
