import type {
  ValidatedArtifactResult,
  ValidatedImageArtifact,
  ValidatedJsonArtifact,
  ValidatedOutputArtifact
} from '../../lib/doc-runtime/output-artifact-validation.js';
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
  outputs: readonly ValidatedArtifactResult[];
}

export default function OutputRenderer({ outputs }: OutputRendererProps) {
  return (
    <>
      {outputs.map((output, index) => (
        <ArtifactErrorBoundary key={artifactKey(output, index)} index={output.index} resetKey={output}>
          <ArtifactOutput output={output} />
        </ArtifactErrorBoundary>
      ))}
    </>
  );
}

function ArtifactOutput({ output }: { output: ValidatedArtifactResult }) {
  if (output.status === 'error') {
    return <ArtifactError message={`Artifact ${output.index + 1}: ${output.message}`} />;
  }

  switch (output.artifact.kind) {
    case 'text':
      return <TextOutput output={output.artifact} />;
    case 'json':
      return <JsonOutput output={output.artifact} />;
    case 'html':
      return <HtmlOutput output={output.artifact} />;
    case 'chart':
      return <LazyChartOutput spec={output.artifact.spec} />;
    case 'table':
      return <TableOutput table={output.artifact} />;
    case 'image':
      return <ImageOutput output={output.artifact} />;
  }
}

export function LazyChartOutput({ load = loadChartOutput, spec }: { load?: LoadChartOutput; spec: ChartSpec }) {
  const [state, setState] = useState<ChartRendererState>({ status: 'loading' });

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
  }, [load]);

  if (state.status === 'loading') {
    return (
      <p class="empty-state" data-testid="chart-loading" role="status">
        Loading chart renderer...
      </p>
    );
  }

  if (state.status === 'error') {
    return (
      <p class="error-state" data-testid="artifact-error" role="alert">
        Chart renderer could not be loaded: {state.message}
      </p>
    );
  }

  const ChartOutput = state.module.default;
  return <ChartOutput spec={spec} />;
}

function TextOutput({ output }: { output: TextArtifact }) {
  const isError = output.stream === 'stderr';
  const className = isError ? 'error-output' : 'run-output';

  return (
    <OutputWithTruncation truncated={output.truncated}>
      <pre class={className} data-testid={isError ? undefined : 'run-output'}>
        <code>{output.content}</code>
      </pre>
    </OutputWithTruncation>
  );
}

function JsonOutput({ output }: { output: ValidatedJsonArtifact }) {
  return (
    <OutputWithTruncation truncated={output.truncated}>
      <pre class="run-output" data-testid="value-output">
        <code>{output.formattedValue}</code>
      </pre>
    </OutputWithTruncation>
  );
}

function ImageOutput({ output }: { output: ValidatedImageArtifact }) {
  return (
    <figure class="doc-image-output">
      <img
        alt={output.alt ?? output.title ?? 'Image output'}
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

function HtmlOutput({ output }: { output: Extract<ValidatedOutputArtifact, { kind: 'html' }> }) {
  return (
    <iframe
      class="doc-html-output"
      data-testid="html-output"
      sandbox=""
      srcdoc={output.html}
      title={output.title ?? 'HTML output'}
    />
  );
}

function OutputWithTruncation({ children, truncated }: { children: ComponentChildren; truncated?: boolean }) {
  return (
    <div class="doc-output-artifact">
      {children}
      {truncated ? (
        <p class="doc-output-artifact__notice" data-testid="artifact-truncated">
          Output truncated.
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
