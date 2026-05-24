import {
  idleOutputMessage,
  labelsForLanguage
} from '../../lib/doc-runtime/interactive-cell-model';
import { normalizeCellExecutionResult } from '../../lib/doc-runtime/output-artifacts';
import type {
  CellExecutionResult,
  CellManifest
} from '../../lib/doc-runtime/types';
import OutputRenderer from './OutputRenderer';

type RuntimeLabels = ReturnType<typeof labelsForLanguage>;

export function CellOutput({
  error,
  isRunning,
  labels,
  result,
  runMode
}: {
  error?: string;
  isRunning: boolean;
  labels: RuntimeLabels;
  result?: CellExecutionResult;
  runMode: CellManifest['run'];
}) {
  if (error) return <p class="error-state">{error}</p>;
  if (isRunning) return <p class="empty-state">{labels.runningCell}</p>;
  if (!result) {
    return (
      <p class="empty-state">
        {idleOutputMessage(runMode, labels)}
      </p>
    );
  }

  const normalizedResult = normalizeCellExecutionResult(result);

  return (
    <div class="doc-cell__outputs">
      <OutputRenderer outputs={normalizedResult.outputs} />
    </div>
  );
}
