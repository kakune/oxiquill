import { useState } from 'preact/hooks';
import { shouldShowInputControls, shouldShowRunButton } from '../../lib/doc-runtime/interactive-cell-model.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { CellManifest } from '../../lib/doc-runtime/types.js';
import { CellOutput } from './CellOutput.js';
import { InputControl } from './InputControl.js';
import { useManifestSnapshot, useRuntimeLabels } from './manifest-hooks.js';
import { useInteractiveCellRun } from './useInteractiveCellRun.js';

interface InteractiveCellProps {
  cell?: CellManifest;
  cellId: string;
}

export default function InteractiveCell({ cell: initialCell, cellId }: InteractiveCellProps) {
  const { cells, version } = useManifestSnapshot();
  const cell =
    cells.find((candidate) => candidate.id === cellId) ?? (initialCell?.id === cellId ? initialCell : undefined);
  const labels = useRuntimeLabels();

  if (!cell) {
    return (
      <section class="doc-cell doc-cell--error">
        <p class="error-state" role="alert">
          {labels.unknownCell(cellId)}
        </p>
      </section>
    );
  }

  return <InteractiveCellPanel key={`${cell.id}:${version}`} cell={cell} labels={labels} runtimeVersion={version} />;
}

function InteractiveCellPanel({
  cell,
  labels,
  runtimeVersion
}: {
  cell: CellManifest;
  labels: RuntimeLabels;
  runtimeVersion: string;
}) {
  const [isSourceVisible, setIsSourceVisible] = useState(cell.showSource);
  const runtime = useInteractiveCellRun(cell, runtimeVersion);
  const ids = interactiveCellIds(cell.id);

  return (
    <section
      class="doc-cell"
      aria-labelledby={ids.title}
      data-cell-id={cell.id}
      data-language={cell.language}
      data-testid={`cell-${cell.id}`}
    >
      <div class="doc-cell__header">
        <div>
          <p class="doc-cell__eyebrow">{labels.runtimeLanguage(cell.language)}</p>
          <h3 id={ids.title}>{cell.title}</h3>
        </div>
        <div class="doc-cell__actions" role="group" aria-labelledby={ids.actionsLabel}>
          <span id={ids.actionsLabel} class="doc-visually-hidden">
            {labels.cellActions}
          </span>
          <button
            type="button"
            class="secondary-button"
            aria-controls={ids.source}
            aria-expanded={isSourceVisible}
            onClick={() => setIsSourceVisible((visible) => !visible)}
          >
            {isSourceVisible ? labels.hideCode : labels.showCode}
          </button>
          {shouldShowRunButton(cell.run) ? (
            <button
              type="button"
              class="run-button"
              aria-busy={runtime.isRunning}
              aria-controls={ids.output}
              aria-disabled={runtime.isRunning || !runtime.inputsValid}
              disabled={!runtime.inputsValid}
              onClick={() => {
                if (!runtime.isRunning && runtime.inputsValid) runtime.run();
              }}
            >
              {runtime.isRunning ? labels.running : labels.run}
            </button>
          ) : null}
        </div>
      </div>

      {shouldShowInputControls(cell.run) && cell.inputs.length > 0 ? (
        <fieldset class="doc-input-grid">
          <legend id={ids.inputsLabel} class="doc-visually-hidden">
            {labels.cellInputs}
          </legend>
          {cell.inputs.map((input) => (
            <InputControl
              key={input.name}
              cellId={cell.id}
              input={input}
              labels={labels}
              value={runtime.values[input.name]}
              onChange={(value) => runtime.setInputValue(input.name, value)}
              onValidityChange={(valid) => runtime.setInputValidity(input.name, valid)}
            />
          ))}
        </fieldset>
      ) : null}

      {isSourceVisible ? (
        <div
          key={`${cell.id}:${cell.source}`}
          id={ids.source}
          class="doc-source"
          data-testid="cell-source"
          dangerouslySetInnerHTML={{ __html: cell.sourceHtml }}
        />
      ) : null}

      <CellOutput
        cellTitle={cell.title}
        result={runtime.result}
        error={runtime.error}
        isRunning={runtime.isRunning}
        labels={labels}
        outputId={ids.output}
        runMode={cell.run}
      />
    </section>
  );
}

function interactiveCellIds(cellId: string) {
  const root = `doc-cell-${cellId}`;
  return {
    actionsLabel: `${root}-actions-label`,
    inputsLabel: `${root}-inputs-label`,
    output: `${root}-output`,
    source: `${root}-source`,
    title: `${root}-title`
  };
}
