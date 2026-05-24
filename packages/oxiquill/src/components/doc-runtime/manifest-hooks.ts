import { useEffect, useMemo, useState } from 'preact/hooks';
import { labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model';
import {
  getManifestSnapshot,
  subscribeManifest
} from '../../lib/doc-runtime/manifest';

export function useManifestSnapshot() {
  const [snapshot, setSnapshot] = useState(getManifestSnapshot);

  useEffect(() => subscribeManifest(() => setSnapshot(getManifestSnapshot())), []);

  return snapshot;
}

export function useRuntimeLabels() {
  return useMemo(() => labelsForLanguage(globalThis.document?.documentElement.lang), []);
}
