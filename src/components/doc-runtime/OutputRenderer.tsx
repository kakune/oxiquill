import { isOutputArtifact } from '../../lib/doc-runtime/output-artifacts';
import type { ImageArtifact, OutputArtifact, TextArtifact } from '../../lib/doc-runtime/types';
import ChartOutput from './ChartOutput';
import TableOutput from './TableOutput';

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
      return <ChartOutput spec={output.spec} />;
    case 'table':
      return <TableOutput table={output} />;
    case 'image':
      return <ImageOutput output={output} />;
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

function ImageOutput({ output }: { output: ImageArtifact }) {
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

function UnknownOutput({ message }: { message: string }) {
  return (
    <p class="error-state" data-testid="artifact-error">
      {message}
    </p>
  );
}

export function imageArtifactSource(output: ImageArtifact): string {
  if (output.data.startsWith('data:')) return output.data;
  if (output.mime === 'image/svg+xml') {
    return `data:${output.mime};charset=utf-8,${encodeURIComponent(output.data)}`;
  }
  return `data:${output.mime};base64,${output.data}`;
}

function artifactKey(output: unknown, index: number): string {
  if (isOutputArtifact(output) && output.id) return output.id;
  return String(index);
}
