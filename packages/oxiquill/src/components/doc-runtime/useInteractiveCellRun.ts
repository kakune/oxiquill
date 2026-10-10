import { useEffect, useRef, useState } from 'preact/hooks';
import { initialValues } from '../../lib/doc-runtime/interactive-cell-model.js';
import { restoreSharedInputs, sharedInputsParameter } from '../../lib/doc-runtime/input-sharing.js';
import { createLatestRequestScheduler, createRunOnceCache } from '../../lib/doc-runtime/interactive-cell-scheduler.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { runInteractiveCell } from '../../lib/doc-runtime/runtime-client.js';
import type { NormalizedCellExecutionResult } from '../../lib/doc-runtime/output-artifacts.js';
import type { CellManifest, InputValues, RuntimeExecutionPhase } from '../../lib/doc-runtime/types.js';

type InputValue = InputValues[string];

type CellRunRequest = {
  autorunKey?: string;
  cell: CellManifest;
  runtimeVersion: string;
  values: InputValues;
  source?: string;
};

type ExecutionState = {
  phase?: RuntimeExecutionPhase;
  status: 'idle' | 'running' | 'success' | 'error';
  result?: NormalizedCellExecutionResult;
  error?: string;
};

const autorunRequests = createRunOnceCache<string, NormalizedCellExecutionResult>();
const reactiveDebounceMs = 150;

export function useInteractiveCellRun(cell: CellManifest, runtimeVersion: string) {
  const [values, setValues] = useState<InputValues>(() => restoreSharedInputs(cell));
  const [execution, setExecution] = useState<ExecutionState>({ status: 'idle' });
  const [inputsValid, setInputsValid] = useState(true);
  const [inputRevision, setInputRevision] = useState(0);
  const [draft, setDraft] = useState<{ original: string; source: string }>();
  const isEditing = cell.language === 'python' && draft?.original === cell.source;
  useEffect(() => {
    if (draft && draft.original !== cell.source) setDraft(undefined);
  }, [cell.source]);
  const invalidInputsRef = useRef(new Set<string>());
  const valuesRef = useRef(values);
  const schedulerRef =
    useRef<ReturnType<typeof createLatestRequestScheduler<CellRunRequest, NormalizedCellExecutionResult>>>();

  schedulerRef.current ??= createLatestRequestScheduler({
    execute: (
      { autorunKey, cell: requestedCell, runtimeVersion: requestedVersion, values: requestedValues, source },
      signal
    ) => {
      const overrides: [] | [{ source: string }] = source === undefined ? [] : [{ source }];
      const execute = () =>
        requestedCell.language === 'python'
          ? runInteractiveCell(
              requestedCell,
              requestedValues,
              requestedVersion,
              signal,
              (phase) => {
                if (!signal.aborted) setExecution((previous) => ({ ...previous, phase }));
              },
              ...overrides
            )
          : runInteractiveCell(requestedCell, requestedValues, requestedVersion, signal);
      return autorunKey ? autorunRequests.getOrCreate(autorunKey, execute) : execute();
    },
    onCancelled: () => {
      setExecution((previous) => ({ ...previous, status: 'idle' }));
    },
    onError: (caught) => {
      setExecution((previous) => ({ ...previous, error: boundedErrorMessage(caught), status: 'error' }));
    },
    onResult: (result) => {
      setExecution({ result, status: 'success' });
    },
    onScheduled: () => {
      setExecution((previous) => ({
        ...previous,
        phase: cell.language === 'python' ? 'preparing' : 'executing',
        status: 'running'
      }));
    }
  });

  useEffect(() => {
    const scheduler = schedulerRef.current;
    return () => scheduler?.dispose();
  }, []);

  useEffect(() => {
    if (isEditing) return;
    if (cell.run === 'reactive' && invalidInputsRef.current.size === 0) {
      schedule(valuesRef.current);
    } else if (cell.run === 'autorun') {
      schedule(valuesRef.current, 0, JSON.stringify([cell.id, runtimeVersion, cell.source, valuesRef.current]));
    }
  }, [cell.id, cell.run, cell.source, runtimeVersion, isEditing]);

  useEffect(() => {
    if (!cell.inputs.some((input) => input.share)) return;
    const sharedQuery = () =>
      JSON.stringify(new URL(globalThis.location.href).searchParams.getAll(sharedInputsParameter));
    let previousQuery = sharedQuery();
    const restore = () => {
      const query = sharedQuery();
      if (query === previousQuery) return;
      previousQuery = query;
      const restored = restoreSharedInputs(cell);
      replaceInputs({
        ...valuesRef.current,
        ...Object.fromEntries(
          cell.inputs.filter((input) => input.share).map((input) => [input.name, restored[input.name]])
        )
      });
    };
    globalThis.addEventListener('popstate', restore);
    return () => globalThis.removeEventListener('popstate', restore);
  }, [cell, isEditing]);

  function schedule(nextValues: InputValues, delayMs = 0, autorunKey?: string): void {
    schedulerRef.current?.schedule(
      { autorunKey, cell, runtimeVersion, values: nextValues, source: isEditing ? draft?.source : undefined },
      delayMs
    );
  }

  function run(): void {
    if (invalidInputsRef.current.size > 0) return;
    schedule(valuesRef.current);
  }

  function setInputValue(inputName: string, value: InputValue) {
    const nextValues = { ...valuesRef.current, [inputName]: value };
    valuesRef.current = nextValues;
    setValues(nextValues);

    if (isEditing) stopExecution();
    else if (cell.run === 'reactive' && invalidInputsRef.current.size === 0) {
      schedule(nextValues, reactiveDebounceMs);
    }
  }

  function resetInputs(): void {
    replaceInputs(initialValues(cell.inputs));
  }

  function replaceInputs(nextValues: InputValues): void {
    schedulerRef.current?.cancel();
    invalidInputsRef.current.clear();
    valuesRef.current = nextValues;
    setValues(nextValues);
    setInputsValid(true);
    setInputRevision((revision) => revision + 1);
    setExecution((previous) => ({ ...previous, error: undefined, status: 'idle' }));
    if (cell.run === 'reactive' && !isEditing) schedule(nextValues, reactiveDebounceMs);
  }

  function stopExecution(): void {
    schedulerRef.current?.cancel();
    setExecution((previous) => ({ ...previous, error: undefined, status: 'idle' }));
  }

  function editSource(source: string): void {
    if (cell.language !== 'python') return;
    stopExecution();
    setDraft({ original: cell.source, source });
  }

  function finishEditing(): void {
    stopExecution();
    setDraft(undefined);
  }

  function setInputValidity(inputName: string, valid: boolean): void {
    const nextInvalidInputs = new Set(invalidInputsRef.current);
    if (valid) {
      nextInvalidInputs.delete(inputName);
    } else {
      nextInvalidInputs.add(inputName);
    }
    if (nextInvalidInputs.size === invalidInputsRef.current.size && nextInvalidInputs.has(inputName) === !valid) return;

    invalidInputsRef.current = nextInvalidInputs;
    setInputsValid(nextInvalidInputs.size === 0);
    if (!valid) {
      schedulerRef.current?.cancel();
      setExecution((previous) => ({ ...previous, status: 'idle' }));
    }
  }

  return {
    phase: execution.phase,
    error: execution.error,
    isComplete: execution.status === 'success',
    inputsValid,
    inputRevision,
    isEditing,
    draftSource: isEditing ? (draft?.source ?? cell.source) : cell.source,
    editSource,
    finishEditing,
    isRunning: execution.status === 'running',
    result: execution.result,
    run,
    resetInputs,
    setInputValue,
    setInputValidity,
    values
  };
}
