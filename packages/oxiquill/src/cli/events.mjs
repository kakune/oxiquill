import { truncateUtf8 } from '../lib/doc-runtime/output-limits.mjs';

export function boundedDisplay(value) {
  const source = value === undefined ? '(missing)' : JSON.stringify(value);
  return truncateUtf8(source, 1024).value;
}

export function createEventReporter({ format = 'human', write = console.log } = {}) {
  return (event) => {
    if (format === 'json') return write(JSON.stringify(event));
    if (event.type === 'test') {
      write(
        `${event.status === 'pass' ? 'PASS' : 'FAIL'} ${event.page}:${event.line} ${event.cell} case=${event.case}`
      );
      event.failures.forEach((failure) =>
        write(
          `  ${event.page}:${failure.location.line}:${failure.location.column} ${failure.fieldPath}: ${failure.reason}; ${failure.path ?? '(execution)'}${failure.artifact ? ` artifact=${failure.artifact}` : ''}; actual=${failure.actual}; expected=${failure.expected}`
        )
      );
    } else if (event.type === 'summary') {
      write(
        `Tests: ${event.passed} passed, ${event.failed} failed, ${event.total} total${event.haskell ? `; Haskell ${event.haskell.status} (${event.haskell.cellCount} cells)` : ''}.`
      );
    } else if (event.type === 'diagnostic') write(event.message);
  };
}
