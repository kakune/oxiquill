import { useEffect, useState } from 'preact/hooks';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { Scene3dArtifact } from '../../lib/doc-runtime/types.js';
import { scene3dLabels } from '../../lib/doc-runtime/scene3d-localization.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';

type SceneModule = typeof import('./Scene3dOutput.js');
let ready: Promise<SceneModule> | undefined;
let attempt = 0;
function loadScene(): Promise<SceneModule> {
  ready ??= (
    attempt === 0 ? import('./Scene3dOutput.js') : (import('./Scene3dOutput.js?oxiquill-retry') as Promise<SceneModule>)
  ).catch((error: unknown) => {
    ready = undefined;
    attempt += 1;
    throw error;
  });
  return ready;
}

export default function LazyScene3dOutput({
  artifact,
  idPrefix,
  labels,
  resultIdentity,
  load = loadScene
}: {
  artifact: Scene3dArtifact;
  idPrefix: string;
  labels: RuntimeLabels;
  resultIdentity?: object;
  load?: () => Promise<SceneModule>;
}) {
  const [state, setState] = useState<{ module?: SceneModule; error?: string }>({});
  const [retry, setRetry] = useState(0);
  const text = scene3dLabels(labels.locale);
  useEffect(() => {
    let cancelled = false;
    setState({});
    Promise.resolve()
      .then(load)
      .then((module) => {
        if (!cancelled) setState({ module });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error: boundedErrorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [load, retry]);
  if (state.module) {
    const Scene = state.module.default;
    return <Scene artifact={artifact} idPrefix={idPrefix} labels={labels} resultIdentity={resultIdentity} />;
  }
  if (state.error !== undefined)
    return (
      <div>
        <p role="alert">
          {text.loadError}: {state.error}
        </p>
        <button type="button" onClick={() => setRetry((value) => value + 1)}>
          {text.retry}
        </button>
      </div>
    );
  return <p role="status">{text.loading}</p>;
}
