import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { initialValues } from '../../lib/doc-runtime/interactive-cell-model';
import { runInteractiveCell } from '../../lib/doc-runtime/runtime-client';
import type {
  CellExecutionResult,
  CellManifest,
  InputValues
} from '../../lib/doc-runtime/types';

type InputValue = InputValues[string];

export function useInteractiveCellRun(cell: CellManifest, runtimeVersion: string) {
  const [values, setValues] = useState<InputValues>(() => initialValues(cell.inputs));
  const [result, setResult] = useState<CellExecutionResult>();
  const [error, setError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const latestRunId = useRef(0);
  const serializedValues = useMemo(() => JSON.stringify(values), [values]);

  useEffect(() => {
    if (cell.run !== 'autorun') return;
    void run();
  }, [cell.id, runtimeVersion]);

  useEffect(() => {
    if (cell.run !== 'reactive') return;
    void run();
  }, [cell.id, runtimeVersion, serializedValues]);

  async function run() {
    const runId = latestRunId.current + 1;
    latestRunId.current = runId;
    setIsRunning(true);
    setError(undefined);

    try {
      const nextResult = await runInteractiveCell(cell, values);
      if (latestRunId.current === runId) {
        setResult(nextResult);
      }
    } catch (caught) {
      if (latestRunId.current === runId) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      if (latestRunId.current === runId) {
        setIsRunning(false);
      }
    }
  }

  function setInputValue(inputName: string, value: InputValue) {
    setValues((current) => ({ ...current, [inputName]: value }));
  }

  return {
    error,
    isRunning,
    result,
    run,
    setInputValue,
    values
  };
}
