import { idleOutputMessage, labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model.js';
import {
  normalizeCellExecutionResult,
  type NormalizedCellExecutionResult
} from '../../lib/doc-runtime/output-artifacts.js';
import type { CellExecutionResult, CellManifest } from '../../lib/doc-runtime/types.js';
import OutputRenderer from './OutputRenderer.js';

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
  result?: CellExecutionResult | NormalizedCellExecutionResult;
  runMode: CellManifest['run'];
}) {
  if (error) return <p class="error-state">{error}</p>;
  if (isRunning) return <p class="empty-state">{labels.runningCell}</p>;
  if (!result) {
    return <p class="empty-state">{idleOutputMessage(runMode, labels)}</p>;
  }

  const outputResults =
    'outputResults' in result ? result.outputResults : normalizeCellExecutionResult(result).outputResults;

  return (
    <div class="doc-cell__outputs">
      <OutputRenderer outputs={outputResults} />
    </div>
  );
}
