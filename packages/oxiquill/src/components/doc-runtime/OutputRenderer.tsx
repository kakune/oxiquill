import type {
  ValidatedArtifactResult,
  ValidatedImageArtifact,
  ValidatedJsonArtifact,
  ValidatedOutputArtifact
} from '../../lib/doc-runtime/output-artifact-validation';
import type { ComponentChildren } from 'preact';
import type { TextArtifact } from '../../lib/doc-runtime/types';
import ArtifactErrorBoundary, { ArtifactError } from './ArtifactErrorBoundary';
import ChartOutput from './ChartOutput';
import TableOutput from './TableOutput';

interface OutputRendererProps {
  outputs: readonly ValidatedArtifactResult[];
}

export default function OutputRenderer({ outputs }: OutputRendererProps) {
  return (
    <>
      {outputs.map((output, index) => (
        <ArtifactErrorBoundary
          key={artifactKey(output, index)}
          index={output.index}
          resetKey={output}
        >
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
      return <ChartOutput spec={output.artifact.spec} />;
    case 'table':
      return <TableOutput table={output.artifact} />;
    case 'image':
      return <ImageOutput output={output.artifact} />;
  }
}

function TextOutput({ output }: { output: TextArtifact }) {
  const isError = output.stream === 'stderr';
  const className = isError ? 'error-output' : 'run-output';

  return <OutputWithTruncation truncated={output.truncated}>
    <pre class={className} data-testid={isError ? undefined : 'run-output'}>
      <code>{output.content}</code>
    </pre>
  </OutputWithTruncation>;
}

function JsonOutput({ output }: { output: ValidatedJsonArtifact }) {
  return <OutputWithTruncation truncated={output.truncated}>
    <pre class="run-output" data-testid="value-output">
      <code>{output.formattedValue}</code>
    </pre>
  </OutputWithTruncation>;
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
      {truncated ? <p class="doc-output-artifact__notice" data-testid="artifact-truncated">Output truncated.</p> : null}
    </div>
  );
}

export function imageArtifactSource(output: ValidatedImageArtifact): string {
  return output.source;
}

function artifactKey(output: ValidatedArtifactResult, index: number): string {
  return output.status === 'valid' && output.artifact.id
    ? `${output.artifact.id}:${index}`
    : String(index);
}
