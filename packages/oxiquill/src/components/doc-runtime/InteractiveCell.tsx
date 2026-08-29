import { useState } from 'preact/hooks';
import {
  labelsForLanguage,
  shouldShowInputControls,
  shouldShowRunButton
} from '../../lib/doc-runtime/interactive-cell-model.js';
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
        <p class="error-state">{labels.unknownCell(cellId)}</p>
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
  labels: ReturnType<typeof labelsForLanguage>;
  runtimeVersion: string;
}) {
  const [isSourceVisible, setIsSourceVisible] = useState(cell.showSource);
  const runtime = useInteractiveCellRun(cell, runtimeVersion);

  return (
    <section class="doc-cell" data-cell-id={cell.id} data-language={cell.language} data-testid={`cell-${cell.id}`}>
      <div class="doc-cell__header">
        <div>
          <p class="doc-cell__eyebrow">{runtimeEyebrow(cell.language)}</p>
          <h3>{cell.title}</h3>
        </div>
        <div class="doc-cell__actions">
          <button
            type="button"
            class="secondary-button"
            aria-expanded={isSourceVisible}
            onClick={() => setIsSourceVisible((visible) => !visible)}
          >
            {isSourceVisible ? labels.hideCode : labels.showCode}
          </button>
          {shouldShowRunButton(cell.run) ? (
            <button type="button" class="run-button" disabled={runtime.isRunning} onClick={runtime.run}>
              {runtime.isRunning ? labels.running : labels.run}
            </button>
          ) : null}
        </div>
      </div>

      {shouldShowInputControls(cell.run) && cell.inputs.length > 0 ? (
        <div class="doc-input-grid">
          {cell.inputs.map((input) => (
            <InputControl
              key={input.name}
              cellId={cell.id}
              input={input}
              value={runtime.values[input.name]}
              onChange={(value) => runtime.setInputValue(input.name, value)}
            />
          ))}
        </div>
      ) : null}

      {isSourceVisible ? (
        <div
          key={`${cell.id}:${cell.source}`}
          class="doc-source"
          data-testid="cell-source"
          dangerouslySetInnerHTML={{ __html: cell.sourceHtml }}
        />
      ) : null}

      <CellOutput
        result={runtime.result}
        error={runtime.error}
        isRunning={runtime.isRunning}
        labels={labels}
        runMode={cell.run}
      />
    </section>
  );
}

function runtimeEyebrow(language: CellManifest['language']): string {
  switch (language) {
    case 'rust':
      return 'Rust + Wasm';
    case 'python':
      return 'Python + Pyodide';
    case 'haskell':
      return 'Haskell + WASI';
  }
}
