import { truncateUtf8 } from '../lib/doc-runtime/output-limits.mjs';

export function boundedDisplay(value) {
  const source = value === undefined ? '(missing)' : JSON.stringify(value);
  return truncateUtf8(source, 1024).value;
}

export function createEventReporter({ format = 'human', write = console.log } = {}) {
  return (event) => {
    if (format === 'json') return write(JSON.stringify(event));
    if (event.type === 'link-failure') {
      write(`${event.reason}: ${event.target} (${event.count} occurrence(s))`);
      event.examples.forEach(({ source, href }) => write(`  ${source}: ${JSON.stringify(href)}`));
    } else if (event.type === 'test') {
      write(
        `${event.status === 'pass' ? 'PASS' : 'FAIL'} ${event.page}:${event.line} ${event.cell} case=${event.case}`
      );
      event.failures.forEach((failure) =>
        write(
          `  ${event.page}:${failure.location.line}:${failure.location.column} ${failure.fieldPath}: ${failure.reason}; ${failure.path ?? '(execution)'}${failure.artifact ? ` artifact=${failure.artifact}` : ''}; actual=${failure.actual}; expected=${failure.expected}`
        )
      );
    } else if (event.type === 'phase') {
      const scope = [event.language, event.module].filter(Boolean).join('/');
      write(
        `${event.phase}${scope ? ` (${scope})` : ''}: ${event.state} (${event.elapsedMs}ms)${event.cache ? `; cache ${event.cache}` : ''}`
      );
    } else if (event.type === 'plan') {
      write(
        `${[event.language, event.module, event.target].filter(Boolean).join('/')}: ${event.action} (${event.reasons.map((reason) => `${reason.code}${reason.variables?.length ? `: ${reason.variables.join(', ')}` : ''}${reason.changes?.length ? `: ${reason.changes.map((change) => `${change.page}${change.cell ? ` (${change.cell})` : ''}`).join(', ')}` : ''}`).join('; ')})`
      );
    } else if (event.type === 'heartbeat') {
      write(
        `still running ${event.phase} (${[event.language, event.module].filter(Boolean).join('/') || 'process'}, ${event.elapsedMs}ms)`
      );
    } else if (event.type === 'summary' && event.phases) {
      write('Build summary:');
      event.phases.forEach((phase) =>
        write(
          `  ${phase.phase}${phase.language ? ` (${[phase.language, phase.module].filter(Boolean).join('/')})` : ''}: ${phase.state}, ${phase.elapsedMs}ms${phase.cache?.hits || phase.cache?.misses ? `, cache ${phase.cache.hits} reused/${phase.cache.misses} built` : ''}`
        )
      );
      if (event.linkCheck) writeLinkSummary(event.linkCheck, write);
      write(`Exit status: ${event.exitStatus}`);
    } else if (event.type === 'summary' && event.linkCheck) {
      writeLinkSummary(event.linkCheck, write);
      write(`Exit status: ${event.exitStatus}`);
    } else if (event.type === 'summary' && event.passed === undefined) {
      write(`Exit status: ${event.exitStatus}`);
    } else if (event.type === 'summary') {
      write(
        `Tests: ${event.passed} passed, ${event.failed} failed, ${event.total} total${event.haskell ? `; Haskell ${event.haskell.status} (${event.haskell.cellCount} cells)` : ''}.`
      );
    } else if (event.type === 'diagnostic') write(event.message);
  };
}

function writeLinkSummary(totals, write) {
  write(
    `Links: ${totals.checked} checked, ${totals.skipped} skipped, ${totals.failures} broken target(s), ${totals.occurrences} failure occurrence(s) across ${totals.pages} page(s).`
  );
}
