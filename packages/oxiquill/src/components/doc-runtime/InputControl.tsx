import {
  effectiveMaximum,
  effectiveMinimum,
  effectiveStep,
  formatInputValue,
  isIntegerInput,
  parseNumericInput,
  stepNumericInputValue,
  type NumericInputValidation
} from '../../lib/doc-runtime/interactive-input-validation.js';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { InputSpec } from '../../lib/doc-runtime/types.js';
import { useEffect, useState } from 'preact/hooks';

type InputValue = string | number | boolean;

export function InputControl({
  cellId,
  input,
  labels,
  value,
  onChange,
  onValidityChange = () => undefined
}: {
  cellId: string;
  input: InputSpec;
  labels: RuntimeLabels;
  onChange: (value: InputValue) => void;
  onValidityChange?: (valid: boolean) => void;
  value: InputValue;
}) {
  const ids = inputControlIds(cellId, input.name);
  const [validation, setValidation] = useState<string>();
  const [editValue, setEditValue] = useState(() => String(value));
  const descriptionId = input.description ? ids.description : undefined;
  const validationId = validation ? ids.validation : undefined;
  const numeric = input.type === 'number' || input.type === 'integer';

  useEffect(() => {
    setEditValue(String(value));
  }, [value]);

  if (input.type === 'checkbox') {
    return (
      <div class="doc-input">
        <label class="doc-input--checkbox" for={ids.control} id={ids.label}>
          <input
            id={ids.control}
            aria-describedby={descriptionId}
            type="checkbox"
            checked={Boolean(value)}
            onInput={(event) => onChange(event.currentTarget.checked)}
          />
          <span>{input.label}</span>
        </label>
        <InputDescription id={descriptionId} description={input.description} />
      </div>
    );
  }

  if (input.type === 'select') {
    return (
      <div class="doc-input">
        <label for={ids.control} id={ids.label}>
          {input.label}
        </label>
        <select
          id={ids.control}
          aria-describedby={descriptionId}
          value={String(value)}
          onInput={(event) => onChange(event.currentTarget.value)}
        >
          {input.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <InputDescription id={descriptionId} description={input.description} />
      </div>
    );
  }

  if (input.type === 'radio') {
    return (
      <fieldset class="doc-input doc-input--radio" aria-describedby={descriptionId}>
        <legend id={ids.label}>{input.label}</legend>
        {input.options.map((option, optionIndex) => (
          <label key={option.value} for={`${ids.control}-option-${optionIndex}`}>
            <input
              id={`${ids.control}-option-${optionIndex}`}
              type="radio"
              name={ids.control}
              value={option.value}
              checked={String(value) === option.value}
              onInput={(event) => onChange(event.currentTarget.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        <InputDescription id={descriptionId} description={input.description} />
      </fieldset>
    );
  }

  if (input.type === 'textarea') {
    return (
      <div class="doc-input">
        <label for={ids.control} id={ids.label}>
          {input.label}
        </label>
        <textarea
          id={ids.control}
          aria-describedby={descriptionId}
          value={String(value)}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <InputDescription id={descriptionId} description={input.description} />
      </div>
    );
  }

  if (input.type === 'range') {
    return (
      <div class="doc-input">
        <div class="doc-input__label-row">
          <label for={ids.control} id={ids.label}>
            {input.label}
          </label>
          <output id={ids.value} for={ids.control} data-testid={`${input.name}-value`}>
            {formatInputValue(value, effectiveStep(input))}
          </output>
        </div>
        <input
          id={ids.control}
          aria-describedby={describedBy(descriptionId, ids.value)}
          type="range"
          min={input.min}
          max={input.max}
          step={input.step}
          value={Number(value)}
          onInput={(event) => onChange(Number(event.currentTarget.value))}
        />
        <InputDescription id={descriptionId} description={input.description} />
      </div>
    );
  }

  return (
    <div class="doc-input">
      <label for={ids.control} id={ids.label}>
        {input.label}
      </label>
      <input
        id={ids.control}
        aria-describedby={descriptionId}
        aria-errormessage={validationId}
        aria-invalid={validation ? true : undefined}
        aria-valuemax={numeric ? effectiveMaximum(input) : undefined}
        aria-valuemin={numeric ? effectiveMinimum(input) : undefined}
        aria-valuenow={numeric && !validation ? Number(editValue) : undefined}
        inputMode={numeric ? (isIntegerInput(input) ? 'numeric' : 'decimal') : undefined}
        role={numeric ? 'spinbutton' : undefined}
        type="text"
        min={numeric ? effectiveMinimum(input) : undefined}
        max={numeric ? effectiveMaximum(input) : undefined}
        step={numeric ? effectiveStep(input) : undefined}
        required={numeric}
        value={numeric ? editValue : String(value)}
        onKeyDown={(event) => {
          if (!numeric || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;

          event.preventDefault();
          const parsed = parseNumericInput(input, editValue);
          const currentValue = parsed.valid ? parsed.value : Number(value);
          const nextValue = stepNumericInputValue(input, currentValue, event.key === 'ArrowUp' ? 1 : -1);
          setEditValue(String(nextValue));
          setValidation(undefined);
          onValidityChange(true);
          onChange(nextValue);
        }}
        onInput={(event) => {
          const rawValue = event.currentTarget.value;
          if (!numeric) {
            onChange(rawValue);
            return;
          }

          setEditValue(rawValue);
          const parsed = parseNumericInput(input, rawValue);
          const nextValidation = parsed.valid ? undefined : inputValidationMessage(parsed.validation, input, labels);
          setValidation(nextValidation);
          onValidityChange(parsed.valid);
          if (parsed.valid) onChange(parsed.value);
        }}
      />
      <InputDescription id={descriptionId} description={input.description} />
      {validation ? (
        <p id={ids.validation} class="doc-input__validation error-state" role="alert">
          {validation}
        </p>
      ) : null}
    </div>
  );
}

export function inputControlId(cellId: string, inputName: string): string {
  return `doc-input-${cellId}-${inputName}`;
}

export function inputControlIds(cellId: string, inputName: string) {
  const control = inputControlId(cellId, inputName);
  return {
    control,
    description: `${control}-description`,
    label: `${control}-label`,
    validation: `${control}-validation`,
    value: `${control}-value`
  };
}

function InputDescription({ description, id }: { description?: string; id?: string }) {
  return description && id ? (
    <p id={id} class="doc-input__description">
      {description}
    </p>
  ) : null;
}

function describedBy(...ids: Array<string | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(' ');
  return value || undefined;
}

function inputValidationMessage(validation: NumericInputValidation, input: InputSpec, labels: RuntimeLabels): string {
  if (validation === 'rangeUnderflow') return labels.inputMinimum(effectiveMinimum(input) as number);
  if (validation === 'rangeOverflow') return labels.inputMaximum(effectiveMaximum(input) as number);
  if (validation === 'stepMismatch') return labels.inputStep;
  if (validation === 'integer' && isIntegerInput(input)) return labels.inputNumber;
  return labels.inputNumber;
}
