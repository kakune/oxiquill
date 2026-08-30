import type {
  ValidatedArtifactResult,
  ValidatedImageArtifact,
  ValidatedJsonArtifact,
  ValidatedOutputArtifact
} from '../../lib/doc-runtime/output-artifact-validation.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import { labelsForLanguage } from '../../lib/doc-runtime/runtime-localization.js';
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ChartSpec, TextArtifact } from '../../lib/doc-runtime/types.js';
import ArtifactErrorBoundary, { ArtifactError } from './ArtifactErrorBoundary.js';
import TableOutput from './TableOutput.js';

type ChartOutputModule = typeof import('./ChartOutput.js');
type LoadChartOutput = () => Promise<ChartOutputModule>;
type ChartRendererState =
  { status: 'loading' } | { status: 'ready'; module: ChartOutputModule } | { status: 'error'; message: string };

let chartOutputModuleReady: Promise<ChartOutputModule> | undefined;

interface OutputRendererProps {
  idPrefix?: string;
  labels?: RuntimeLabels;
  outputs: readonly ValidatedArtifactResult[];
  resultIdentity?: object;
}

export default function OutputRenderer({
  idPrefix = 'doc-output',
  labels = labelsForLanguage(globalThis.document?.documentElement.lang),
  outputs,
  resultIdentity
}: OutputRendererProps) {
  return (
    <>
      {outputs.map((output, index) => (
        <ArtifactErrorBoundary key={artifactKey(output, index)} index={output.index} labels={labels} resetKey={output}>
          <ArtifactOutput
            idPrefix={`${idPrefix}-artifact-${output.index}`}
            labels={labels}
            output={output}
            resultIdentity={resultIdentity}
          />
        </ArtifactErrorBoundary>
      ))}
    </>
  );
}

function ArtifactOutput({
  idPrefix,
  labels,
  output,
  resultIdentity
}: {
  idPrefix: string;
  labels: RuntimeLabels;
  output: ValidatedArtifactResult;
  resultIdentity?: object;
}) {
  if (output.status === 'error') {
    return <ArtifactError message={labels.artifactError(output.index + 1, labels.diagnosticDetail(output.message))} />;
  }

  switch (output.artifact.kind) {
    case 'text':
      return <TextOutput labels={labels} output={output.artifact} />;
    case 'json':
      return <JsonOutput labels={labels} output={output.artifact} />;
    case 'html':
      return <HtmlOutput labels={labels} output={output.artifact} />;
    case 'chart':
      return <LazyChartOutput artifact={output.artifact} idPrefix={idPrefix} labels={labels} />;
    case 'table':
      return (
        <TableOutput idPrefix={idPrefix} labels={labels} table={output.artifact} resultIdentity={resultIdentity} />
      );
    case 'image':
      return <ImageOutput labels={labels} output={output.artifact} />;
  }
}

export function LazyChartOutput({
  artifact,
  idPrefix = 'doc-chart',
  labels = labelsForLanguage(globalThis.document?.documentElement.lang),
  load = loadChartOutput,
  spec
}: {
  artifact?: Extract<ValidatedOutputArtifact, { kind: 'chart' }>;
  spec?: ChartSpec;
} & {
  idPrefix?: string;
  labels?: RuntimeLabels;
  load?: LoadChartOutput;
}) {
  const chartArtifact = artifact ?? { kind: 'chart' as const, spec: spec as ChartSpec };
  const [state, setState] = useState<ChartRendererState>({ status: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    Promise.resolve()
      .then(load)
      .then((module) => {
        if (!cancelled) setState({ status: 'ready', module });
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message: caught instanceof Error ? caught.message : String(caught)
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [load, loadAttempt]);

  if (state.status === 'loading') {
    return (
      <p class="empty-state" data-testid="chart-loading" role="status">
        {labels.chartLoading}
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <div class="doc-chart-output__error">
        <p class="error-state" data-testid="artifact-error" role="alert">
          {labels.chartLoadError(state.message)}
        </p>
        <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>
          {labels.chartRetry}
        </button>
      </div>
    );
  }

  const ChartOutput = state.module.default;
  return <ChartOutput artifact={chartArtifact} idPrefix={idPrefix} labels={labels} />;
}

function TextOutput({ labels, output }: { labels: RuntimeLabels; output: TextArtifact }) {
  const isError = output.stream === 'stderr';
  const className = isError ? 'error-output' : 'run-output';

  return (
    <OutputWithTruncation labels={labels} truncated={output.truncated}>
      <pre class={className} data-testid={isError ? undefined : 'run-output'}>
        <code>{output.content}</code>
      </pre>
    </OutputWithTruncation>
  );
}

function JsonOutput({ labels, output }: { labels: RuntimeLabels; output: ValidatedJsonArtifact }) {
  return (
    <OutputWithTruncation labels={labels} truncated={output.truncated}>
      <pre class="run-output" data-testid="value-output">
        <code>{output.formattedValue}</code>
      </pre>
    </OutputWithTruncation>
  );
}

function ImageOutput({ labels, output }: { labels: RuntimeLabels; output: ValidatedImageArtifact }) {
  return (
    <figure class="doc-image-output">
      <img
        alt={output.alt ?? output.title ?? labels.imageOutput}
        data-testid="image-output"
        src={imageArtifactSource(output)}
      />
      {output.title || output.caption ? (
        <figcaption>
          {output.title ? <strong>{output.title}</strong> : null}
          {output.title && output.caption ? ' ' : null}
          {output.caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function HtmlOutput({
  labels,
  output
}: {
  labels: RuntimeLabels;
  output: Extract<ValidatedOutputArtifact, { kind: 'html' }>;
}) {
  return (
    <iframe
      class="doc-html-output"
      data-testid="html-output"
      referrerPolicy="no-referrer"
      sandbox=""
      srcdoc={htmlArtifactSrcdoc(output.html)}
      title={output.title ?? labels.htmlOutput}
    />
  );
}

export const htmlArtifactContentSecurityPolicy = [
  "default-src 'none'",
  'img-src data: blob:',
  'media-src data: blob:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

export function htmlArtifactSrcdoc(html: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${htmlArtifactContentSecurityPolicy}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

function OutputWithTruncation({
  children,
  labels,
  truncated
}: {
  children: ComponentChildren;
  labels: RuntimeLabels;
  truncated?: boolean;
}) {
  return (
    <div class="doc-output-artifact">
      {children}
      {truncated ? (
        <p class="doc-output-artifact__notice" data-testid="artifact-truncated">
          {labels.outputTruncated}
        </p>
      ) : null}
    </div>
  );
}

export function imageArtifactSource(output: ValidatedImageArtifact): string {
  return output.source;
}

function artifactKey(output: ValidatedArtifactResult, index: number): string {
  return output.status === 'valid' && output.artifact.id ? `${output.artifact.id}:${index}` : String(index);
}

function loadChartOutput(): Promise<ChartOutputModule> {
  chartOutputModuleReady ??= import('./ChartOutput.js').catch((error: unknown) => {
    chartOutputModuleReady = undefined;
    throw error;
  });
  return chartOutputModuleReady;
}
