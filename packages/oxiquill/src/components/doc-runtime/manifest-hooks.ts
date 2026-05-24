import { useEffect, useMemo, useState } from 'preact/hooks';
import { labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model';
import {
  getManifestSnapshot,
  refreshGeneratedManifest,
  subscribeManifest
} from '../../lib/doc-runtime/manifest';

export function useManifestSnapshot() {
  const [snapshot, setSnapshot] = useState(getManifestSnapshot);

  useEffect(() => {
    const unsubscribe = subscribeManifest(() => setSnapshot(getManifestSnapshot()));
    const refreshSnapshot = () => {
      void refreshGeneratedManifest().then(() => {
        setSnapshot(getManifestSnapshot());
      });
    };
    const timers = [0, 250, 1_000, 2_500, 5_000].map((delay) => window.setTimeout(refreshSnapshot, delay));

    return () => {
      unsubscribe();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  return snapshot;
}

export function useRuntimeLabels() {
  return useMemo(() => labelsForLanguage(globalThis.document?.documentElement.lang), []);
}
