import { Component, type ComponentChildren } from 'preact';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';

interface ArtifactErrorBoundaryProps {
  children: ComponentChildren;
  index: number;
  labels: RuntimeLabels;
  resetKey: object;
}

interface ArtifactErrorBoundaryState {
  error: string | undefined;
}

export default class ArtifactErrorBoundary extends Component<ArtifactErrorBoundaryProps, ArtifactErrorBoundaryState> {
  state: ArtifactErrorBoundaryState = { error: undefined };

  componentDidCatch(error: unknown): void {
    this.setState({ error: boundedErrorMessage(error) });
  }

  componentDidUpdate(previousProps: ArtifactErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error !== undefined) {
      this.setState({ error: undefined });
    }
  }

  render({ children, index, labels }: ArtifactErrorBoundaryProps, { error }: ArtifactErrorBoundaryState) {
    if (error !== undefined) {
      return <ArtifactError message={labels.artifactRenderError(index + 1, error)} />;
    }
    return children;
  }
}

export function ArtifactError({ message }: { message: string }) {
  return (
    <p class="error-state" data-testid="artifact-error" role="alert">
      {message}
    </p>
  );
}
