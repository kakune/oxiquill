import { boundedErrorMessage } from './output-limits.mjs';
import { normalizeCellExecutionResult, type NormalizedCellExecutionResult } from './output-artifacts.js';

export class CellExecutionError extends Error {
  readonly partialResult?: NormalizedCellExecutionResult;

  constructor(message: string, partialResult?: unknown) {
    super(boundedErrorMessage(message));
    this.name = 'CellExecutionError';
    if (partialResult !== undefined) this.partialResult = normalizeCellExecutionResult(partialResult);
  }
}
