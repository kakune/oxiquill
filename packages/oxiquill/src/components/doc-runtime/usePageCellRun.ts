import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { getPageCellStore } from '../../lib/doc-runtime/page-cell-store.js';
import type { CellManifest, InputValues } from '../../lib/doc-runtime/types.js';

export function usePageCellRun(cell: CellManifest) {
  const [store, setStore] = useState(() => (typeof document === 'undefined' ? undefined : getPageCellStore(cell)));
  const [snapshot, setSnapshot] = useState(() => store?.get(cell.id));
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setStore(getPageCellStore(cell));
    };
    globalThis.addEventListener('pageshow', restore);
    return () => globalThis.removeEventListener('pageshow', restore);
  }, [cell]);
  useLayoutEffect(() => {
    if (!store) return;
    const update = () => setSnapshot(store.get(cell.id));
    const unsubscribe = store.subscribe(update);
    update();
    store.start(cell.id);
    return unsubscribe;
  }, [store, cell.id]);
  useEffect(() => {
    if (store) setSnapshot(store.get(cell.id));
  }, [cell]);
  const values = snapshot?.values ?? Object.fromEntries(cell.inputs.map((input) => [input.name, input.value]));
  return {
    isStale: snapshot?.stale ?? false,
    upstreamChanged: snapshot?.upstreamChanged,
    upstreamFailure: snapshot?.upstreamFailure,
    reused: snapshot?.reused,
    phase: undefined,
    error: snapshot?.error,
    partialResult: snapshot?.partialResult,
    isComplete: snapshot?.status === 'success',
    inputsValid: !snapshot?.invalid.size,
    inputRevision: snapshot?.inputRevision ?? 0,
    isEditing: false,
    draftSource: cell.source,
    editSource: (source: string) => {
      void source;
    },
    finishEditing: () => undefined,
    isRunning: snapshot?.status === 'running',
    result: snapshot?.result,
    run: () => store?.run(cell.id),
    recompute: () => store?.run(cell.id, true),
    resetInputs: () => store?.reset(cell.id),
    applyCase: (id: string) => {
      const selected = cell.cases?.find((candidate) => candidate.id === id);
      if (selected) store?.setValues(cell.id, selected.inputs, true);
    },
    setInputValue: (name: string, value: InputValues[string]) =>
      store?.setValues(cell.id, { ...store.get(cell.id).values, [name]: value }),
    setInputValidity: (name: string, valid: boolean) => store?.setValidity(cell.id, name, valid),
    values
  };
}
