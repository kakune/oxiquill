import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createInputShareUrl, registerSharedInputs, sharedInputMetadata } from '../../lib/doc-runtime/input-sharing.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { getPythonPreparationState, subscribePythonPreparation } from '../../lib/doc-runtime/runtime-client.js';
import { markRuntimeEvent } from '../../lib/doc-runtime/runtime-timing.js';
import { shouldShowInputControls, shouldShowRunButton } from '../../lib/doc-runtime/interactive-cell-model.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { CellManifest } from '../../lib/doc-runtime/types.js';
import { CellOutput } from './CellOutput.js';
import { cellExecutionTimeoutMs } from '../../lib/doc-runtime/interactive-cell-model.js';
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
      <section class="doc-cell doc-cell--error not-content">
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
  const section = useRef<HTMLElement>(null);
  const snapshot = useRef(runtime);
  snapshot.current = runtime;
  const [shareStatus, setShareStatus] = useState<{ error: boolean; message: string }>();
  useLayoutEffect(() => {
    if (section.current)
      return registerSharedInputs(section.current, () => ({
        values: snapshot.current.values,
        valid: snapshot.current.inputsValid
      }));
  }, []);
  const ids = interactiveCellIds(cell.id);
  const [pythonPreparation, setPythonPreparation] = useState<ReturnType<typeof getPythonPreparationState>>('idle');
  useEffect(() => {
    if (cell.language !== 'python') return;
    const update = () => setPythonPreparation(getPythonPreparationState());
    const unsubscribe = subscribePythonPreparation(update);
    update();
    return unsubscribe;
  }, [cell.language]);
  useLayoutEffect(() => {
    markRuntimeEvent('hydrated', cell.id);
  }, [cell.id]);
  useLayoutEffect(() => {
    if (runtime.result) markRuntimeEvent('output-rendered', cell.id);
  }, [cell.id, runtime.result]);

  return (
    <section
      ref={section}
      class="doc-cell not-content"
      aria-labelledby={ids.title}
      data-cell-id={cell.id}
      data-share-inputs={sharedInputMetadata(cell)}
      data-language={cell.language}
      data-python-packages={cell.language === 'python' ? JSON.stringify(cell.packages) : undefined}
      data-python-timeout={cell.language === 'python' ? cellExecutionTimeoutMs(cell) : undefined}
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
          {cell.inputs.length > 0 ? (
            <button type="button" class="secondary-button" onClick={runtime.resetInputs}>
              {labels.resetInputs}
            </button>
          ) : null}
          {cell.inputs.some((input) => input.share) ? (
            <button
              type="button"
              class="secondary-button"
              onClick={async () => {
                try {
                  const url = createInputShareUrl(cell.pagePath);
                  if (!globalThis.navigator.clipboard) throw new Error(labels.clipboardUnavailable);
                  await navigator.clipboard.writeText(url);
                  setShareStatus({ error: false, message: labels.copyLinkSuccess });
                } catch (error) {
                  setShareStatus({ error: true, message: labels.copyLinkError(boundedErrorMessage(error)) });
                }
              }}
            >
              {labels.copyLink}
            </button>
          ) : null}
          {cell.editable ? (
            <button
              type="button"
              class="secondary-button"
              aria-expanded={runtime.isEditing}
              onClick={() => (runtime.isEditing ? runtime.finishEditing() : runtime.editSource(cell.source))}
            >
              {runtime.isEditing ? labels.finishEditing : labels.editCode}
            </button>
          ) : null}
          {shouldShowRunButton(cell.run) || runtime.isEditing ? (
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
              {runtime.isRunning
                ? runtime.phase === 'preparing'
                  ? labels.pythonPreparing
                  : labels.running
                : labels.run}
            </button>
          ) : null}
        </div>
      </div>

      {shareStatus ? <p role={shareStatus.error ? 'alert' : 'status'}>{shareStatus.message}</p> : null}

      {shouldShowInputControls(cell.run) && cell.inputs.length > 0 ? (
        <fieldset class="doc-input-grid">
          <legend id={ids.inputsLabel} class="doc-visually-hidden">
            {labels.cellInputs}
          </legend>
          {cell.inputs.map((input) => (
            <InputControl
              key={`${input.name}:${runtime.inputRevision}`}
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

      {runtime.isEditing ? (
        <div class="doc-source-editor" id={ids.source}>
          <label for={`${ids.source}-editor`}>{labels.pythonDraft}</label>
          <textarea
            id={`${ids.source}-editor`}
            value={runtime.draftSource}
            spellcheck={false}
            onInput={(event) => runtime.editSource(event.currentTarget.value)}
          />
          <button type="button" class="secondary-button" onClick={() => runtime.editSource(cell.source)}>
            {labels.restoreCode}
          </button>
          <p>{labels.pythonEditorHelp}</p>
        </div>
      ) : isSourceVisible ? (
        <div
          key={`${cell.id}:${cell.source}`}
          id={ids.source}
          class="doc-source"
          data-testid="cell-source"
          dangerouslySetInnerHTML={{ __html: cell.sourceHtml }}
        />
      ) : null}

      {cell.language === 'python' && pythonPreparation === 'preparing' && !runtime.isRunning ? (
        <p class="doc-cell__preparing" role="status">
          {labels.pythonPreparing}
        </p>
      ) : null}
      <CellOutput
        cellTitle={cell.title}
        result={runtime.result}
        error={runtime.error}
        partialResult={runtime.partialResult}
        isRunning={runtime.isRunning}
        isPreparing={runtime.phase === 'preparing'}
        isComplete={runtime.isComplete}
        retry={runtime.run}
        canRetry={runtime.inputsValid}
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
