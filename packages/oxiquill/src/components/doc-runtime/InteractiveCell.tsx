import { getPageCellStore } from '../../lib/doc-runtime/page-cell-store.js';
import { usePageCellRun } from './usePageCellRun.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createInputShareUrl, registerSharedInputs, sharedInputMetadata } from '../../lib/doc-runtime/input-sharing.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { getPythonPreparationState, subscribePythonPreparation } from '../../lib/doc-runtime/runtime-client.js';
import { markRuntimeEvent } from '../../lib/doc-runtime/runtime-timing.js';
import {
  matchingInputCase,
  shouldShowInputControls,
  shouldShowRunButton
} from '../../lib/doc-runtime/interactive-cell-model.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type {
  AuthoredBlockManifest,
  CellCompileError,
  CellManifest,
  RustRuntimeModule,
  PageCellManifest
} from '../../lib/doc-runtime/types.js';
import { CellOutput } from './CellOutput.js';
import { cellExecutionTimeoutMs } from '../../lib/doc-runtime/interactive-cell-model.js';
import { InputControl } from './InputControl.js';
import { useManifestSnapshot, useRuntimeLabels } from './manifest-hooks.js';
import { useInteractiveCellRun } from './useInteractiveCellRun.js';

interface InteractiveCellProps {
  cell?: AuthoredBlockManifest;
  rustModule?: RustRuntimeModule;
  cellId: string;
}

export default function InteractiveCell({
  cell: initialCell,
  cellId,
  rustModule: initialRustModule
}: InteractiveCellProps) {
  const { cells, version, rust, definitions, compileErrors, failedBlocks } = useManifestSnapshot();
  const cell =
    cells.find((candidate) => candidate.id === cellId) ??
    definitions?.find((candidate) => candidate.id === cellId) ??
    failedBlocks?.find((candidate) => candidate.id === cellId) ??
    (initialCell?.id === cellId ? initialCell : undefined);
  const rustModule = rust ? rust.modules.find((module) => module.cells.includes(cellId)) : initialRustModule;
  const labels = useRuntimeLabels();
  const errors = compileErrors?.filter((error) => error.cellId === cellId) ?? [];

  if (!cell) {
    return (
      <section class="doc-cell doc-cell--error not-content">
        <p class="error-state" role="alert">
          {labels.unknownCell(cellId)}
        </p>
      </section>
    );
  }

  if ('kind' in cell || (cell.language === 'rust' && !rustModule && errors.length > 0)) {
    return (
      <BlockSourcePanel
        cell={failedBlocks?.find((block) => block.id === cellId) ?? cell}
        errors={errors}
        labels={labels}
      />
    );
  }

  return (
    <InteractiveCellPanel
      key={`${cell.id}:${cell.language}:${Boolean(cell.exports || cell.dependsOn)}`}
      cell={cell}
      labels={labels}
      runtimeVersion={version}
      rustModule={rustModule}
      errors={errors}
    />
  );
}

function CompileErrors({ errors }: { errors: readonly CellCompileError[] }) {
  if (!errors.length) return null;
  return (
    <div role="alert" class="error-state" data-testid="cell-compile-errors">
      {errors.map((error, index) => (
        <p key={index}>
          <code>
            {error.file}:{error.line}:{error.column}
          </code>{' '}
          {error.code ? `${error.code}: ` : ''}
          {error.message}
        </p>
      ))}
    </div>
  );
}

function BlockSourcePanel({
  cell,
  errors,
  labels
}: {
  cell: AuthoredBlockManifest;
  errors: readonly CellCompileError[];
  labels: RuntimeLabels;
}) {
  const [visible, setVisible] = useState(cell.showSource);
  const ids = interactiveCellIds(cell.id);
  return (
    <section
      class="doc-cell not-content"
      data-cell-id={cell.id}
      data-testid={`cell-${cell.id}`}
      data-language={cell.language}
      aria-labelledby={ids.title}
    >
      <div class="doc-cell__header">
        <h3 id={ids.title}>{cell.title}</h3>
        <button
          type="button"
          class="secondary-button"
          aria-expanded={visible}
          aria-controls={ids.source}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? labels.hideCode : labels.showCode}
        </button>
      </div>
      <CompileErrors errors={errors} />
      {visible ? (
        <div
          id={ids.source}
          class="doc-source"
          data-testid="cell-source"
          dangerouslySetInnerHTML={{ __html: cell.sourceHtml }}
        />
      ) : null}
    </section>
  );
}

function InteractiveCellPanel({
  cell,
  labels,
  runtimeVersion,
  rustModule,
  errors
}: {
  cell: CellManifest;
  labels: RuntimeLabels;
  runtimeVersion: string;
  rustModule?: RustRuntimeModule;
  errors: readonly CellCompileError[];
}) {
  const [isSourceVisible, setIsSourceVisible] = useState(cell.showSource);
  const useCellRun = cell.exports || cell.dependsOn ? usePageCellRun : useIndependentRun;
  const runtime = useCellRun(
    cell,
    cell.language === 'rust' ? (rustModule?.fingerprint ?? 'not-ready') : runtimeVersion,
    rustModule
  );
  const selectedCase = runtime.inputsValid ? matchingInputCase(cell, runtime.values) : undefined;
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
      id={cell.ref ? `ox-ref-${cell.ref}` : undefined}
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
          {cell.cache === 'inputs' ? (
            <button
              type="button"
              class="secondary-button"
              disabled={runtime.isRunning || !runtime.inputsValid}
              onClick={runtime.recompute}
            >
              {labels.recompute}
            </button>
          ) : null}
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
          {cell.inputs.some((input) => input.share) || cell.cases?.length ? (
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
      <CompileErrors errors={errors} />

      {shouldShowInputControls(cell.run) && (cell.inputs.length > 0 || cell.cases?.length) ? (
        <fieldset class="doc-input-grid">
          <legend id={ids.inputsLabel} class="doc-visually-hidden">
            {labels.cellInputs}
          </legend>
          {cell.cases?.length ? (
            <div class="doc-input">
              <label for={ids.caseSelector}>{labels.inputCase}</label>
              <select
                id={ids.caseSelector}
                value={selectedCase?.id ?? ''}
                aria-describedby={selectedCase?.description ? ids.caseDescription : undefined}
                onChange={(event) => runtime.applyCase(event.currentTarget.value)}
              >
                <option value="" disabled>
                  {labels.customValues}
                </option>
                {cell.cases.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
              {selectedCase?.description ? (
                <p id={ids.caseDescription} class="doc-input__description">
                  {selectedCase.description}
                </p>
              ) : null}
            </div>
          ) : null}
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
        reused={runtime.reused}
        upstreamChanged={runtime.upstreamChanged}
        upstreamFailure={runtime.upstreamFailure}
        cellTitle={cell.title}
        result={runtime.result}
        error={runtime.error}
        partialResult={runtime.partialResult}
        isRunning={runtime.isRunning}
        isPreparing={runtime.phase === 'preparing'}
        isComplete={runtime.isComplete}
        isStale={runtime.isStale}
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
    caseSelector: `${root}-case`,
    caseDescription: `${root}-case-description`,
    output: `${root}-output`,
    source: `${root}-source`,
    title: `${root}-title`
  };
}

function useIndependentRun(...args: Parameters<typeof useInteractiveCellRun>) {
  const runtime = useInteractiveCellRun(...args);
  const cell = args[0];
  useLayoutEffect(() => {
    const hasDescriptor = [...document.querySelectorAll<HTMLScriptElement>('script[data-oxiquill-page]')].some(
      (element) => element.dataset.oxiquillPage === cell.pagePath
    );
    if (hasDescriptor) getPageCellStore(cell).recordIndependent(cell.id, runtime);
  }, [
    cell,
    runtime.values,
    runtime.result,
    runtime.error,
    runtime.isRunning,
    runtime.isComplete,
    runtime.inputsValid,
    runtime.isStale,
    runtime.inputRevision
  ]);
  return {
    ...runtime,
    reused: false,
    upstreamChanged: false,
    upstreamFailure: undefined,
    recompute: undefined
  };
}

// One descriptor per page makes offscreen producers available before their
// islands hydrate. Escaping '<' prevents authored source from ending the script.
export function PageCellData({ page }: { page: PageCellManifest }) {
  return (
    <script
      type="application/json"
      data-oxiquill-page={page.cells[0]?.pagePath}
      dangerouslySetInnerHTML={{ __html: JSON.stringify(page).replace(/</gu, '\\u003c') }}
    />
  );
}
