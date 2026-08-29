import { Component, type ComponentChildren } from 'preact';

interface ArtifactErrorBoundaryProps {
  children: ComponentChildren;
  index: number;
  resetKey: object;
}

interface ArtifactErrorBoundaryState {
  error?: string;
}

export default class ArtifactErrorBoundary extends Component<
  ArtifactErrorBoundaryProps,
  ArtifactErrorBoundaryState
> {
  state: ArtifactErrorBoundaryState = {};

  componentDidCatch(error: unknown): void {
    this.setState({ error: error instanceof Error ? error.message : String(error) });
  }

  componentDidUpdate(previousProps: ArtifactErrorBoundaryProps): void {
    if (previousProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  render({ children, index }: ArtifactErrorBoundaryProps, { error }: ArtifactErrorBoundaryState) {
    if (error) {
      return <ArtifactError message={`Artifact ${index + 1} failed to render: ${error}`} />;
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
