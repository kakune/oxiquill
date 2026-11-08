export class InteractiveCellValidationError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map(formatInteractiveCellDiagnostic).join('\n'));
    this.name = 'InteractiveCellValidationError';
    this.diagnostics = diagnostics;
  }
}

export function formatInteractiveCellDiagnostic(value) {
  const pagePath = value.pagePath || '(unknown page)';
  const cell = value.cellId ? ` [cell ${JSON.stringify(value.cellId)}]` : '';
  return `${pagePath}:${value.line ?? value.fenceStartLine}${value.column ? `:${value.column}` : ''}${cell} ${value.fieldPath}: ${value.message}`;
}
