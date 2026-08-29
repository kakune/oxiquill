import { coerceInputValue, formatInputValue } from '../../lib/doc-runtime/interactive-cell-model.js';
import type { InputSpec } from '../../lib/doc-runtime/types.js';

type InputValue = string | number | boolean;

export function InputControl({
  cellId,
  input,
  value,
  onChange
}: {
  cellId: string;
  input: InputSpec;
  onChange: (value: InputValue) => void;
  value: InputValue;
}) {
  const id = inputControlId(cellId, input.name);

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

export function inputControlId(cellId: string, inputName: string): string {
  return `doc-input-${cellId}-${inputName}`;
}
