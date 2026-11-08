import type { OutcomeArtifact, OutcomeState } from '../../lib/doc-runtime/types.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import { formatTableNumber } from '../../lib/doc-runtime/table-format.js';

const icons: Record<OutcomeState, string> = { satisfied: '✓', partial: '◐', failed: '×', unavailable: '–' };

export default function OutcomeOutput({ output, labels }: { output: OutcomeArtifact; labels: RuntimeLabels }) {
  return (
    <section class="doc-outcome" data-outcome={output.state} aria-label={labels.outcomeLabel}>
      <p>
        <span aria-hidden="true">{icons[output.state]}</span>{' '}
        <strong>
          {labels.outcomeState(output.state)}: {output.label}
        </strong>
      </p>
      {output.explanation !== undefined ? <p>{output.explanation}</p> : null}
      {output.status !== undefined ? (
        <p>
          {labels.outcomeStatus}: <code>{output.status}</code>
        </p>
      ) : null}
      {output.diagnostics?.length ? (
        <dl>
          {output.diagnostics.map((diagnostic) => (
            <div>
              <dt>{diagnostic.name}</dt>
              <dd>
                {formatTableNumber(diagnostic.value, labels.locale)}
                {diagnostic.unit ? ` ${diagnostic.unit}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}
