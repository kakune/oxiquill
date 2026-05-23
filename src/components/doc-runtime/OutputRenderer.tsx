import { isOutputArtifact } from '../../lib/doc-runtime/output-artifacts';
import type { ChartArtifact, OutputArtifact, PlotSpec, TextArtifact } from '../../lib/doc-runtime/types';
import PlotOutput from './PlotOutput';

interface OutputRendererProps {
  outputs: readonly unknown[];
}

export default function OutputRenderer({ outputs }: OutputRendererProps) {
  return (
    <>
      {outputs.map((output, index) => (
        <ArtifactOutput key={artifactKey(output, index)} output={output} />
      ))}
    </>
  );
}

function ArtifactOutput({ output }: { output: unknown }) {
  if (!isOutputArtifact(output)) {
    return <UnknownOutput message="Unsupported output artifact." />;
  }

  switch (output.kind) {
    case 'text':
      return <TextOutput output={output} />;
    case 'json':
      return (
        <pre class="run-output" data-testid="value-output">
          <code>{JSON.stringify(output.value, null, 2)}</code>
        </pre>
      );
    case 'html':
      return <HtmlOutput output={output} />;
    case 'chart':
      return <ChartOutput output={output} />;
    case 'table':
    case 'image':
      return <UnknownOutput message={`Unsupported ${output.kind} output artifact.`} />;
    default:
      return <UnknownOutput message="Unsupported output artifact." />;
  }
}

function TextOutput({ output }: { output: TextArtifact }) {
  const isError = output.stream === 'stderr';
  const className = isError ? 'error-output' : 'run-output';

  return (
    <pre class={className} data-testid={isError ? undefined : 'run-output'}>
      <code>{output.content}</code>
    </pre>
  );
}

function HtmlOutput({ output }: { output: Extract<OutputArtifact, { kind: 'html' }> }) {
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

function ChartOutput({ output }: { output: ChartArtifact }) {
  const plot = legacyPlotFromChart(output);

  if (!plot) {
    return <UnknownOutput message="Unsupported chart output artifact." />;
  }

  return <PlotOutput plot={plot} />;
}

function legacyPlotFromChart(output: ChartArtifact): PlotSpec | undefined {
  if (output.spec.kind !== 'line' || output.spec.series.length !== 1) return undefined;

  const points = output.spec.series[0]?.points;
  if (!points?.every((point) => point.every((value) => typeof value === 'number'))) {
    return undefined;
  }

  return {
    kind: 'line',
    x_label: output.spec.xLabel ?? '',
    y_label: output.spec.yLabel ?? '',
    points: points as readonly [number, number][]
  };
}

function UnknownOutput({ message }: { message: string }) {
  return (
    <p class="error-state" data-testid="artifact-error">
      {message}
    </p>
  );
}

function artifactKey(output: unknown, index: number): string {
  if (isOutputArtifact(output) && output.id) return output.id;
  return String(index);
}
