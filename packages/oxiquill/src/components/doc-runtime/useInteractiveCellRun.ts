import { useEffect, useRef, useState } from 'preact/hooks';
import { initialValues } from '../../lib/doc-runtime/interactive-cell-model.js';
import { createLatestRequestScheduler, createRunOnceCache } from '../../lib/doc-runtime/interactive-cell-scheduler.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { runInteractiveCell } from '../../lib/doc-runtime/runtime-client.js';
import type { NormalizedCellExecutionResult } from '../../lib/doc-runtime/output-artifacts.js';
import type { CellManifest, InputValues } from '../../lib/doc-runtime/types.js';

type InputValue = InputValues[string];

type CellRunRequest = {
  autorunKey?: string;
  cell: CellManifest;
  runtimeVersion: string;
  values: InputValues;
};

type ExecutionState =
  | { status: 'idle' }
  | { status: 'running' }
  | { result: NormalizedCellExecutionResult; status: 'success' }
  | { error: string; status: 'error' };

const autorunRequests = createRunOnceCache<string, NormalizedCellExecutionResult>();
const reactiveDebounceMs = 150;

export function useInteractiveCellRun(cell: CellManifest, runtimeVersion: string) {
  const [values, setValues] = useState<InputValues>(() => initialValues(cell.inputs));
  const [execution, setExecution] = useState<ExecutionState>({ status: 'idle' });
  const [inputsValid, setInputsValid] = useState(true);
  const invalidInputsRef = useRef(new Set<string>());
  const valuesRef = useRef(values);
  const schedulerRef =
    useRef<ReturnType<typeof createLatestRequestScheduler<CellRunRequest, NormalizedCellExecutionResult>>>();

  schedulerRef.current ??= createLatestRequestScheduler({
    execute: (
      { autorunKey, cell: requestedCell, runtimeVersion: requestedVersion, values: requestedValues },
      signal
    ) => {
      const execute = () => runInteractiveCell(requestedCell, requestedValues, requestedVersion, signal);
      return autorunKey ? autorunRequests.getOrCreate(autorunKey, execute) : execute();
    },
    onCancelled: () => {
      setExecution({ status: 'idle' });
    },
    onError: (caught) => {
      setExecution({ error: boundedErrorMessage(caught), status: 'error' });
    },
    onResult: (result) => {
      setExecution({ result, status: 'success' });
    },
    onScheduled: () => {
      setExecution({ status: 'running' });
    }
  });

  useEffect(() => {
    const scheduler = schedulerRef.current;
    return () => scheduler?.dispose();
  }, []);

  useEffect(() => {
    if (cell.run === 'reactive') {
      schedule(valuesRef.current);
    } else if (cell.run === 'autorun') {
      schedule(valuesRef.current, 0, JSON.stringify([cell.id, runtimeVersion]));
    }
  }, [cell.id, cell.run, runtimeVersion]);

  function schedule(nextValues: InputValues, delayMs = 0, autorunKey?: string): void {
    schedulerRef.current?.schedule({ autorunKey, cell, runtimeVersion, values: nextValues }, delayMs);
  }

  function run(): void {
    if (invalidInputsRef.current.size > 0) return;
    schedule(valuesRef.current);
  }

  function setInputValue(inputName: string, value: InputValue) {
    const nextValues = { ...valuesRef.current, [inputName]: value };
    valuesRef.current = nextValues;
    setValues(nextValues);

    if (cell.run === 'reactive' && invalidInputsRef.current.size === 0) {
      schedule(nextValues, reactiveDebounceMs);
    }
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
      setExecution({ status: 'idle' });
    }
  }

  return {
    error: execution.status === 'error' ? execution.error : undefined,
    inputsValid,
    isRunning: execution.status === 'running',
    result: execution.status === 'success' ? execution.result : undefined,
    run,
    setInputValue,
    setInputValidity,
    values
  };
}
