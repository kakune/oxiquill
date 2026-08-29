import type { MermaidConfig } from 'mermaid';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { labelsForLanguage, type MermaidDiagramKind } from '../../lib/doc-runtime/runtime-localization.js';

interface MermaidDiagramProps {
  diagramId: string;
  source: string;
}

type RenderState = 'idle' | 'rendering' | 'ready' | 'error';
type MermaidColorScheme = 'light' | 'dark';
type MermaidApi = (typeof import('mermaid'))['default'];

let configuredMermaidColorScheme: MermaidColorScheme | undefined;
let mermaidReady: Promise<MermaidApi> | undefined;

export default function MermaidDiagram({ diagramId, source }: MermaidDiagramProps) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [state, setState] = useState<RenderState>('idle');
  const [colorScheme, setColorScheme] = useState<MermaidColorScheme>(() => getMermaidColorScheme());
  const renderId = useMemo(() => `doc-${diagramId}`, [diagramId]);
  const labels = useMemo(() => labelsForLanguage(globalThis.document?.documentElement.lang), []);
  const ids = mermaidIds(diagramId);

  useEffect(() => {
    setColorScheme(getMermaidColorScheme());

    if (typeof MutationObserver === 'undefined') return undefined;

    const observer = new MutationObserver(() => {
      setColorScheme(getMermaidColorScheme());
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;

    let cancelled = false;

    async function renderDiagram(renderElement: HTMLDivElement) {
      setState('rendering');
      setError(undefined);
      renderElement.replaceChildren();

      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;

        initializeMermaid(mermaid, colorScheme);
        const { svg, bindFunctions } = await mermaid.render(renderId, source);
        if (cancelled) return;

        renderElement.innerHTML = svg;
        hideRenderedSvgFromAccessibility(renderElement);
        bindFunctions?.(renderElement);
        setState('ready');
      } catch (caught) {
        if (cancelled) return;

        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        setState('error');
      }
    }

    void renderDiagram(element);

    return () => {
      cancelled = true;
      element.replaceChildren();
    };
  }, [colorScheme, renderId, source]);

  return (
    <figure
      class="mermaid-diagram"
      aria-labelledby={ids.title}
      aria-describedby={ids.description}
      data-state={state}
      data-testid="mermaid-diagram"
    >
      <span id={ids.title} class="doc-visually-hidden">
        {labels.mermaidTitle(mermaidDiagramKind(source))}
      </span>
      <span id={ids.description} class="doc-visually-hidden">
        {labels.mermaidDescription(source)}
      </span>
      <div
        ref={container}
        class="mermaid-diagram__surface"
        aria-describedby={ids.description}
        aria-labelledby={ids.title}
        role="img"
      />
      {state === 'idle' || state === 'rendering' ? (
        <figcaption class="empty-state" role="status">
          {labels.mermaidLoading}
        </figcaption>
      ) : error ? (
        <figcaption class="error-state" role="alert">
          {labels.mermaidError(error)}
        </figcaption>
      ) : null}
    </figure>
  );
}

export function mermaidDiagramKind(source: string): MermaidDiagramKind {
  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('%%'))
    ?.toLowerCase();
  if (!firstLine) return 'diagram';
  if (firstLine.startsWith('flowchart') || firstLine.startsWith('graph')) return 'flowchart';
  if (firstLine.startsWith('sequencediagram')) return 'sequence';
  if (firstLine.startsWith('statediagram')) return 'state';
  if (firstLine.startsWith('classdiagram')) return 'class';
  if (firstLine.startsWith('erdiagram')) return 'entityRelationship';
  if (firstLine.startsWith('journey')) return 'journey';
  if (firstLine.startsWith('timeline')) return 'timeline';
  return 'diagram';
}

function mermaidIds(diagramId: string) {
  const root = `doc-mermaid-${diagramId}`;
  return { description: `${root}-description`, title: `${root}-title` };
}

function hideRenderedSvgFromAccessibility(container: HTMLDivElement): void {
  const svg = container.querySelector('svg');
  svg?.setAttribute('aria-hidden', 'true');
  svg?.setAttribute('focusable', 'false');
}

export function getMermaidColorScheme(): MermaidColorScheme {
  if (typeof document === 'undefined') return 'light';

  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function initializeMermaid(mermaid: MermaidApi, colorScheme: MermaidColorScheme): void {
  if (configuredMermaidColorScheme === colorScheme) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: mermaidThemeVariables[colorScheme]
  });

  configuredMermaidColorScheme = colorScheme;
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidReady ??= import('mermaid')
    .then((module) => module.default)
    .catch((error: unknown) => {
      mermaidReady = undefined;
      throw error;
    });
  return mermaidReady;
}

const mermaidFontFamily = 'system-ui, sans-serif';

const mermaidThemeVariables = {
  light: {
    fontFamily: mermaidFontFamily,
    primaryColor: '#f8fafc',
    primaryTextColor: '#111827',
    primaryBorderColor: '#64748b',
    lineColor: '#0f766e',
    secondaryColor: '#ecfeff',
    secondaryTextColor: '#111827',
    secondaryBorderColor: '#0891b2',
    tertiaryColor: '#f1f5f9',
    tertiaryTextColor: '#111827',
    tertiaryBorderColor: '#94a3b8',
    textColor: '#111827',
    arrowheadColor: '#0f766e',
    edgeLabelBackground: '#f8fafc',
    nodeTextColor: '#111827',
    clusterBkg: '#f8fafc',
    clusterBorder: '#94a3b8',
    titleColor: '#111827',
    actorBorder: '#64748b',
    actorBkg: '#f8fafc',
    actorTextColor: '#111827',
    actorLineColor: '#0f766e',
    signalColor: '#0f766e',
    signalTextColor: '#111827',
    noteBkgColor: '#fef9c3',
    noteTextColor: '#111827',
    noteBorderColor: '#ca8a04',
    stateBkg: '#f8fafc',
    stateBorder: '#64748b',
    stateLabelColor: '#111827',
    transitionColor: '#0f766e',
    transitionLabelColor: '#111827'
  },
  dark: {
    fontFamily: mermaidFontFamily,
    background: '#0f172a',
    primaryColor: '#1e293b',
    primaryTextColor: '#f8fafc',
    primaryBorderColor: '#94a3b8',
    lineColor: '#67e8f9',
    secondaryColor: '#164e63',
    secondaryTextColor: '#f8fafc',
    secondaryBorderColor: '#67e8f9',
    tertiaryColor: '#334155',
    tertiaryTextColor: '#f8fafc',
    tertiaryBorderColor: '#cbd5e1',
    textColor: '#f8fafc',
    mainBkg: '#1e293b',
    nodeBkg: '#1e293b',
    nodeBorder: '#94a3b8',
    nodeTextColor: '#f8fafc',
    arrowheadColor: '#67e8f9',
    edgeLabelBackground: '#0f172a',
    labelTextColor: '#f8fafc',
    labelBoxBkgColor: '#1e293b',
    labelBoxBorderColor: '#94a3b8',
    clusterBkg: '#111827',
    clusterBorder: '#94a3b8',
    titleColor: '#f8fafc',
    actorBorder: '#94a3b8',
    actorBkg: '#1e293b',
    actorTextColor: '#f8fafc',
    actorLineColor: '#67e8f9',
    signalColor: '#e2e8f0',
    signalTextColor: '#f8fafc',
    noteBkgColor: '#1f2937',
    noteTextColor: '#f8fafc',
    noteBorderColor: '#facc15',
    stateBkg: '#1e293b',
    stateBorder: '#94a3b8',
    stateLabelColor: '#f8fafc',
    transitionColor: '#67e8f9',
    transitionLabelColor: '#f8fafc',
    labelBackgroundColor: '#0f172a',
    compositeBackground: '#111827',
    compositeBorder: '#94a3b8',
    compositeTitleBackground: '#1e293b'
  }
} satisfies Record<MermaidColorScheme, MermaidConfig['themeVariables']>;
