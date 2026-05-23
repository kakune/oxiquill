import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  coerceInputValue,
  formatInputValue,
  idleOutputMessage,
  initialValues,
  labelsForLanguage,
  shouldShowRunButton
} from '../../lib/doc-runtime/interactive-cell-model';
import { getCell, getManifestSnapshot, subscribeManifest } from '../../lib/doc-runtime/manifest';
import { runInteractiveCell } from '../../lib/doc-runtime/runtime-client';
import type {
  CellExecutionResult,
  CellManifest,
  InputSpec,
  InputValues
} from '../../lib/doc-runtime/types';
import PlotOutput from './PlotOutput';

interface InteractiveCellProps {
  cellId: string;
}

export default function InteractiveCell({ cellId }: InteractiveCellProps) {
  const { version } = useManifestSnapshot();
  const cell = getCell(cellId);
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
  const [values, setValues] = useState<InputValues>(() => initialValues(cell.inputs));
  const [result, setResult] = useState<CellExecutionResult>();
  const [error, setError] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [isSourceVisible, setIsSourceVisible] = useState(cell.showSource);

  const serializedValues = useMemo(() => JSON.stringify(values), [values]);

  useEffect(() => {
    if (cell.run !== 'autorun') return;
    void run();
  }, [cell.id, runtimeVersion]);

  useEffect(() => {
    if (cell.run !== 'reactive') return;
    void run();
  }, [cell.id, runtimeVersion, serializedValues]);

  async function run() {
    setIsRunning(true);
    setError(undefined);

    try {
      setResult(await runInteractiveCell(cell, values));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section class="doc-cell" data-language={cell.language} data-testid={`cell-${cell.id}`}>
      <div class="doc-cell__header">
        <div>
          <p class="doc-cell__eyebrow">{cell.language === 'rust' ? 'Rust + Wasm' : 'Python + Pyodide'}</p>
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
            <button type="button" class="run-button" disabled={isRunning} onClick={run}>
              {isRunning ? labels.running : labels.run}
            </button>
          ) : null}
        </div>
      </div>

      {cell.inputs.length > 0 ? (
        <div class="doc-input-grid">
          {cell.inputs.map((input) => (
            <InputControl
              key={input.name}
              input={input}
              value={values[input.name]}
              onChange={(value) => setValues((current) => ({ ...current, [input.name]: value }))}
            />
          ))}
        </div>
      ) : null}

      {isSourceVisible ? (
        <div
          class="doc-source"
          data-testid="cell-source"
          dangerouslySetInnerHTML={{ __html: cell.sourceHtml }}
        />
      ) : null}

      <CellOutput result={result} error={error} isRunning={isRunning} labels={labels} runMode={cell.run} />
    </section>
  );
}

function useManifestSnapshot() {
  const [snapshot, setSnapshot] = useState(getManifestSnapshot);

  useEffect(() => subscribeManifest(() => setSnapshot(getManifestSnapshot())), []);

  return snapshot;
}

function useRuntimeLabels() {
  return useMemo(() => labelsForLanguage(globalThis.document?.documentElement.lang), []);
}

function InputControl({
  input,
  value,
  onChange
}: {
  input: InputSpec;
  onChange: (value: string | number | boolean) => void;
  value: string | number | boolean;
}) {
  const id = `doc-input-${input.name}`;

  if (input.type === 'checkbox') {
    return (
      <label class="doc-input doc-input--checkbox" for={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onInput={(event) => onChange(event.currentTarget.checked)}
        />
        <span>{input.label}</span>
      </label>
    );
  }

  if (input.type === 'select') {
    return (
      <label class="doc-input" for={id}>
        <span>{input.label}</span>
        <select id={id} value={String(value)} onInput={(event) => onChange(event.currentTarget.value)}>
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (input.type === 'radio') {
    return (
      <fieldset class="doc-input doc-input--radio">
        <legend>{input.label}</legend>
        {input.options.map((option) => (
          <label key={option.value}>
            <input
              type="radio"
              name={id}
              value={option.value}
              checked={String(value) === option.value}
              onInput={(event) => onChange(event.currentTarget.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (input.type === 'textarea') {
    return (
      <label class="doc-input" for={id}>
        <span>{input.label}</span>
        <textarea id={id} value={String(value)} onInput={(event) => onChange(event.currentTarget.value)} />
      </label>
    );
  }

  if (input.type === 'range') {
    return (
      <label class="doc-input" for={id}>
        <span>
          {input.label} <strong data-testid={`${input.name}-value`}>{formatInputValue(value)}</strong>
        </span>
        <input
          id={id}
          aria-label={input.name}
          type="range"
          min={input.min}
          max={input.max}
          step={input.step}
          value={Number(value)}
          onInput={(event) => onChange(Number(event.currentTarget.value))}
        />
      </label>
    );
  }

  const numeric = input.type === 'number' || input.type === 'integer';

  return (
    <label class="doc-input" for={id}>
      <span>{input.label}</span>
      <input
        id={id}
        aria-label={input.name}
        type={numeric ? 'number' : 'text'}
        min={input.min}
        max={input.max}
        step={input.step}
        value={String(value)}
        onInput={(event) => {
          onChange(coerceInputValue(input, event.currentTarget.value));
        }}
      />
    </label>
  );
}

function CellOutput({
  error,
  isRunning,
  labels,
  result,
  runMode
}: {
  error?: string;
  isRunning: boolean;
  labels: ReturnType<typeof labelsForLanguage>;
  result?: CellExecutionResult;
  runMode: CellManifest['run'];
}) {
  if (error) return <p class="error-state">{error}</p>;
  if (isRunning) return <p class="empty-state">{labels.runningCell}</p>;
  if (!result) {
    return (
      <p class="empty-state">
        {idleOutputMessage(runMode, labels)}
      </p>
    );
  }

  return (
    <div class="doc-cell__outputs">
      {result.stdout ? (
        <pre class="run-output" data-testid="run-output">
          <code>{result.stdout}</code>
        </pre>
      ) : null}
      {result.stderr ? <pre class="error-output">{result.stderr}</pre> : null}
      {result.value != null && result.value !== '' ? (
        <pre class="run-output" data-testid="value-output">
          <code>{JSON.stringify(result.value, null, 2)}</code>
        </pre>
      ) : null}
      {result.plots.map((plot, index) => (
        <PlotOutput key={index} plot={plot} />
      ))}
    </div>
  );
}
