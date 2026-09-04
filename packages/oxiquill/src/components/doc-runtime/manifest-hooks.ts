import { useEffect, useMemo, useState } from 'preact/hooks';
import { labelsForLanguage } from '../../lib/doc-runtime/interactive-cell-model.js';
import {
  getManifestSnapshot,
  scheduleGeneratedManifestRefresh,
  subscribeManifest
} from '../../lib/doc-runtime/manifest.js';

export function useManifestSnapshot() {
  const [snapshot, setSnapshot] = useState(getManifestSnapshot);

  useEffect(() => {
    const unsubscribe = subscribeManifest(() => setSnapshot(getManifestSnapshot()));
    scheduleGeneratedManifestRefresh();

    return unsubscribe;
  }, []);

  return snapshot;
}

export function useRuntimeLabels() {
  const [languageTag, setLanguageTag] = useState<string>();

  useEffect(() => {
    setLanguageTag(globalThis.document?.documentElement.lang);
  }, []);

  return useMemo(() => labelsForLanguage(languageTag), [languageTag]);
}
