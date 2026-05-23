import mermaid from 'mermaid';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

interface MermaidDiagramProps {
  diagramId: string;
  source: string;
}

type RenderState = 'idle' | 'rendering' | 'ready' | 'error';

let hasInitializedMermaid = false;

export default function MermaidDiagram({ diagramId, source }: MermaidDiagramProps) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [state, setState] = useState<RenderState>('idle');
  const renderId = useMemo(() => `doc-${diagramId}`, [diagramId]);

  useEffect(() => {
    const element = container.current!;

    let cancelled = false;

    async function renderDiagram() {
      setState('rendering');
      setError(undefined);
      element.replaceChildren();

      try {
        initializeMermaid();
        const { svg, bindFunctions } = await mermaid.render(renderId, source);
        if (cancelled) return;

        element.innerHTML = svg;
        bindFunctions?.(element);
        setState('ready');
      } catch (caught) {
        if (cancelled) return;

        const message = caught instanceof Error ? caught.message : String(caught);
        element.textContent = 'Mermaid diagram could not be rendered.';
        setError(message);
        setState('error');
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
      element.replaceChildren();
    };
  }, [renderId, source]);

  return (
    <figure class="mermaid-diagram" data-state={state} data-testid="mermaid-diagram">
      <div ref={container} class="mermaid-diagram__surface" aria-label="Mermaid diagram" />
      {error ? (
        <figcaption class="error-state" role="alert">
          {error}
        </figcaption>
      ) : null}
    </figure>
  );
}

function initializeMermaid(): void {
  if (hasInitializedMermaid) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      fontFamily: 'system-ui, sans-serif',
      primaryColor: '#f8fafc',
      primaryTextColor: '#111827',
      primaryBorderColor: '#64748b',
      lineColor: '#0f766e',
      secondaryColor: '#ecfeff',
      tertiaryColor: '#f1f5f9'
    }
  });

  hasInitializedMermaid = true;
}
