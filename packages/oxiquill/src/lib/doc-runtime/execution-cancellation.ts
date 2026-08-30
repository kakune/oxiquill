export class ExecutionCancellationError extends Error {
  constructor(message = 'Interactive cell execution was cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export function isExecutionCancellation(error: unknown): boolean {
  return (
    error instanceof ExecutionCancellationError ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}
