import YAML from 'yaml';
import { scopedCellId } from './authoring-ids.mjs';
import { numericStepGrid } from './numeric-step.mjs';
import { isPortableInteger, PORTABLE_INTEGER_MAX, PORTABLE_INTEGER_MIN } from './portable-integer.mjs';

export const inputTypes = ['range', 'number', 'integer', 'text', 'textarea', 'checkbox', 'select', 'radio'];
export const runModes = ['button', 'reactive', 'autorun'];
export const supportedLanguages = new Map([
  ['rust', 'rust'],
  ['rs', 'rust'],
  ['python', 'python'],
  ['py', 'python'],
  ['haskell', 'haskell'],
  ['hs', 'haskell']
]);
export const supportedPyodidePackages = [
  'contourpy',
  'cycler',
  'fonttools',
  'kiwisolver',
  'matplotlib',
  'numpy',
  'packaging',
  'pandas',
  'pillow',
  'pyparsing',
  'python-dateutil',
  'pytz',
  'six'
];

const cellFields = new Set(['id', 'title', 'run', 'inputs', 'packages', 'crates', 'timeoutMs', 'showSource']);
const inputFields = new Set(['type', 'label', 'description', 'value', 'min', 'max', 'step', 'integer', 'options']);
const optionFields = new Set(['label', 'value']);
const localIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const inputNamePattern = /^[a-z][a-z0-9_]*$/u;
const anyOptionPattern = /^\s*(?:\/\/\/?\||#\||--\|)/u;
const optionPatterns = {
  haskell: /^\s*--\|\s?(.*)$/u,
  python: /^\s*#\|\s?(.*)$/u,
  rust: /^\s*\/\/\/?\|\s?(.*)$/u
};

export class InteractiveCellValidationError extends Error {
  constructor(diagnostics) {
    super(diagnostics.map(formatInteractiveCellDiagnostic).join('\n'));
    this.name = 'InteractiveCellValidationError';
    this.diagnostics = diagnostics;
  }
}

export function parseLanguage(info) {
  const raw = String(info ?? '')
    .trim()
    .split(/\s+/u)[0]
    .replace(/[{}]/gu, '')
    .replace(/^\./u, '');
  return supportedLanguages.get(raw);
}

export function parseInteractiveCellNode(node, pagePath) {
  if (!node || node.type !== 'code') return { kind: 'skip' };

  const language = parseLanguage(node.lang);
  if (!language) return { kind: 'skip' };

  const location = {
    fenceStartLine: node.position?.start?.line ?? 1,
    pagePath: pagePath ?? ''
  };
  const split = splitCellSource(node.value ?? '', language, location);
  if (split.kind !== 'cell') return split;

  let metadata;
  try {
    metadata = YAML.parse(split.metadataLines.join('\n')) ?? {};
  } catch (error) {
    return invalidResult([
      diagnostic(location, 'metadata', `Malformed YAML: ${error instanceof Error ? error.message : String(error)}`)
    ]);
  }

  if (!isRecord(metadata)) {
    return invalidResult([diagnostic(location, 'metadata', 'Expected a YAML mapping.')]);
  }

  const cellId = typeof metadata.id === 'string' ? metadata.id : undefined;
  const context = { ...location, cellId };
  const diagnostics = unknownFieldDiagnostics(metadata, cellFields, context, '');
  const localId = normalizeLocalId(metadata.id, context, diagnostics);
  const title = normalizeString(metadata, 'title', localId ?? '', context, diagnostics);
  const run = normalizeRunMode(metadata, context, diagnostics);
  const timeoutMs = normalizeTimeout(metadata, context, diagnostics);
  const showSource = normalizeBoolean(metadata, 'showSource', true, context, diagnostics);
  const inputs = normalizeInputs(metadata, context, diagnostics);
  const packages = normalizeStringArray(metadata, 'packages', context, diagnostics);
  const crates = normalizeStringArray(metadata, 'crates', context, diagnostics);

  validateDependencyFields(metadata, language, packages, context, diagnostics);
  if (run === 'autorun' && hasOwn(metadata, 'inputs')) {
    diagnostics.push(diagnostic(context, 'inputs', 'Autorun cells cannot specify inputs.'));
  }

  const source = split.sourceLines.join('\n').trim();
  if (!source) diagnostics.push(diagnostic(context, 'source', 'Expected non-empty cell source code.'));
  if (diagnostics.length > 0 || !localId) return invalidResult(diagnostics);

  return {
    kind: 'cell',
    cell: {
      id: scopedCellId(pagePath, localId),
      localId,
      language,
      title,
      run,
      source,
      inputs,
      packages,
      crates,
      timeoutMs,
      showSource,
      pagePath: pagePath ?? '',
      fenceStartLine: location.fenceStartLine
    }
  };
}

export function splitCellSource(rawSource, language, location = { fenceStartLine: 1, pagePath: '' }) {
  const lines = String(rawSource).split('\n');
  const pattern = optionPatterns[language];
  const firstMatch = lines[0]?.match(pattern);

  if (!firstMatch) {
    if (anyOptionPattern.test(lines[0] ?? '')) {
      return invalidResult([
        diagnostic(
          location,
          'metadata',
          `Expected ${languageLabel(language)} option comments at the start of the cell.`
        )
      ]);
    }
    return { kind: 'skip' };
  }

  const metadataLines = [];
  let sourceStart = 0;
  while (sourceStart < lines.length) {
    const match = lines[sourceStart].match(pattern);
    if (!match) break;
    metadataLines.push(match[1]);
    sourceStart += 1;
  }

  return {
    kind: 'cell',
    metadataLines,
    sourceLines: lines.slice(sourceStart)
  };
}

export function validateCellDependencies(cell, helperCrates = new Map()) {
  if (cell.language !== 'rust') return [];

  return cell.crates.flatMap((crateName, index) => {
    if (helperCrates.has(crateName)) return [];
    const validCrates = Array.from(helperCrates.keys()).join(', ') || '(none)';
    return [
      diagnostic(
        cell,
        `crates[${index}]`,
        `Unknown Rust helper crate ${JSON.stringify(crateName)}. Available crates: ${validCrates}.`
      )
    ];
  });
}

export function uniqueCellIdDiagnostics(cells) {
  const localIds = new Map();
  const scopedIds = new Map();
  const diagnostics = [];

  for (const cell of cells) {
    const localKey = cell.localId ? `${cell.pagePath}\0${cell.localId}` : undefined;
    const previousLocal = localKey ? localIds.get(localKey) : undefined;
    if (previousLocal) {
      diagnostics.push(
        diagnostic(
          cell,
          'id',
          `Duplicate page-local cell id ${JSON.stringify(cell.localId)}; first declared at ${cellLocation(previousLocal)}.`
        )
      );
    } else if (localKey) {
      localIds.set(localKey, cell);
    }

    const previousScoped = scopedIds.get(cell.id);
    const previousLocalKey = previousScoped?.localId
      ? `${previousScoped.pagePath}\0${previousScoped.localId}`
      : undefined;
    if (previousScoped && (!localKey || localKey !== previousLocalKey)) {
      diagnostics.push(
        diagnostic(
          cell,
          'id',
          `Scoped cell id ${JSON.stringify(cell.id)} collides with the cell declared at ${cellLocation(previousScoped)}.`
        )
      );
    } else if (!previousScoped) {
      scopedIds.set(cell.id, cell);
    }
  }

  return diagnostics;
}

export function formatInteractiveCellDiagnostic(value) {
  const pagePath = value.pagePath || '(unknown page)';
  const cell = value.cellId ? ` [cell ${JSON.stringify(value.cellId)}]` : '';
  return `${pagePath}:${value.fenceStartLine}${cell} ${value.fieldPath}: ${value.message}`;
}

export function throwInteractiveCellDiagnostics(diagnostics) {
  if (diagnostics.length > 0) throw new InteractiveCellValidationError(diagnostics);
}

function normalizeLocalId(value, context, diagnostics) {
  if (typeof value !== 'string' || !localIdPattern.test(value)) {
    diagnostics.push(
      diagnostic(
        context,
        'id',
        'Expected a required lowercase kebab-case identifier matching /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.'
      )
    );
    return undefined;
  }
  return value;
}

function normalizeString(metadata, field, fallback, context, diagnostics) {
  if (!hasOwn(metadata, field)) return fallback;
  if (typeof metadata[field] === 'string') return metadata[field];
  diagnostics.push(diagnostic(context, field, 'Expected a string.'));
  return fallback;
}

function normalizeBoolean(metadata, field, fallback, context, diagnostics) {
  if (!hasOwn(metadata, field)) return fallback;
  if (typeof metadata[field] === 'boolean') return metadata[field];
  diagnostics.push(diagnostic(context, field, 'Expected a boolean.'));
  return fallback;
}

function normalizeRunMode(metadata, context, diagnostics) {
  if (!hasOwn(metadata, 'run')) return 'button';
  if (typeof metadata.run === 'string' && runModes.includes(metadata.run)) return metadata.run;
  diagnostics.push(diagnostic(context, 'run', `Expected one of: ${runModes.join(', ')}.`));
  return 'button';
}

function normalizeTimeout(metadata, context, diagnostics) {
  if (!hasOwn(metadata, 'timeoutMs')) return 30_000;
  const value = metadata.timeoutMs;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0) return value;
  diagnostics.push(diagnostic(context, 'timeoutMs', 'Expected a positive finite integer.'));
  return 30_000;
}

function normalizeStringArray(metadata, field, context, diagnostics) {
  if (!hasOwn(metadata, field)) return [];
  const value = metadata[field];
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic(context, field, 'Expected an array of unique non-empty strings.'));
    return [];
  }

  const seen = new Set();
  const normalized = [];
  value.forEach((item, index) => {
    const fieldPath = `${field}[${index}]`;
    if (typeof item !== 'string' || item.trim() === '') {
      diagnostics.push(diagnostic(context, fieldPath, 'Expected a non-empty string.'));
      return;
    }

    const trimmed = item.trim();
    if (seen.has(trimmed)) {
      diagnostics.push(diagnostic(context, fieldPath, `Duplicate value ${JSON.stringify(trimmed)}.`));
      return;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  });

  return normalized.sort();
}

function normalizeInputs(metadata, context, diagnostics) {
  if (!hasOwn(metadata, 'inputs')) return [];
  if (!isRecord(metadata.inputs)) {
    diagnostics.push(diagnostic(context, 'inputs', 'Expected a mapping of input names to input definitions.'));
    return [];
  }

  return Object.entries(metadata.inputs).map(([name, value]) => normalizeInput(name, value, context, diagnostics));
}

function normalizeInput(name, value, context, diagnostics) {
  const inputPath = `inputs.${name}`;
  if (!inputNamePattern.test(name)) {
    diagnostics.push(
      diagnostic(context, inputPath, 'Expected a lowercase cross-language identifier matching /^[a-z][a-z0-9_]*$/.')
    );
  }
  if (!isRecord(value)) {
    diagnostics.push(diagnostic(context, inputPath, 'Expected an input definition mapping.'));
    return defaultInput(name);
  }

  diagnostics.push(...unknownFieldDiagnostics(value, inputFields, context, `${inputPath}.`));
  const type = normalizeInputType(value, inputPath, context, diagnostics);
  const label = normalizeInputLabel(value, name, inputPath, context, diagnostics);
  const description = normalizeInputDescription(value, inputPath, context, diagnostics);
  const integer = normalizeInputInteger(value, type, inputPath, context, diagnostics);
  const inputValue = normalizeInputValue(value, type, inputPath, context, diagnostics);
  const min = normalizeInputNumber(value, 'min', type, inputPath, context, diagnostics);
  const max = normalizeInputNumber(value, 'max', type, inputPath, context, diagnostics);
  const step = normalizeInputNumber(value, 'step', type, inputPath, context, diagnostics);
  const options = normalizeOptions(value, type, inputPath, context, diagnostics);

  validateNumericConstraints(
    { integer, max, min, step, type, value: inputValue },
    value,
    inputPath,
    context,
    diagnostics
  );
  validateOptionDefault(type, inputValue, options, inputPath, context, diagnostics);

  return {
    name,
    type,
    label,
    ...(description ? { description } : {}),
    value: inputValue,
    min,
    max,
    step,
    integer,
    options
  };
}

function normalizeInputType(value, inputPath, context, diagnostics) {
  if (!hasOwn(value, 'type')) return 'text';
  if (typeof value.type === 'string' && inputTypes.includes(value.type)) return value.type;
  diagnostics.push(diagnostic(context, `${inputPath}.type`, `Expected one of: ${inputTypes.join(', ')}.`));
  return 'text';
}

function normalizeInputLabel(value, name, inputPath, context, diagnostics) {
  if (!hasOwn(value, 'label')) return name;
  if (typeof value.label === 'string' && value.label.trim() !== '') return value.label.trim();
  diagnostics.push(diagnostic(context, `${inputPath}.label`, 'Expected a non-empty string.'));
  return name;
}

function normalizeInputDescription(value, inputPath, context, diagnostics) {
  if (!hasOwn(value, 'description')) return undefined;
  if (typeof value.description === 'string' && value.description.trim() !== '') return value.description.trim();
  diagnostics.push(diagnostic(context, `${inputPath}.description`, 'Expected a non-empty string.'));
  return undefined;
}

function normalizeInputInteger(value, type, inputPath, context, diagnostics) {
  if (!hasOwn(value, 'integer')) return type === 'integer';
  if (typeof value.integer !== 'boolean') {
    diagnostics.push(diagnostic(context, `${inputPath}.integer`, 'Expected a boolean.'));
    return type === 'integer';
  }
  if (!isNumericInput(type)) {
    diagnostics.push(diagnostic(context, `${inputPath}.integer`, 'This field is only valid for numeric inputs.'));
  }
  return value.integer || type === 'integer';
}

function normalizeInputValue(value, type, inputPath, context, diagnostics) {
  const fallback = defaultInputValue(type);
  if (!hasOwn(value, 'value')) return fallback;
  const candidate = value.value;
  const valid =
    type === 'checkbox'
      ? typeof candidate === 'boolean'
      : isNumericInput(type)
        ? typeof candidate === 'number' && Number.isFinite(candidate)
        : typeof candidate === 'string';
  if (valid) return candidate;
  diagnostics.push(diagnostic(context, `${inputPath}.value`, `Expected ${inputValueType(type)}.`));
  return fallback;
}

function normalizeInputNumber(value, field, type, inputPath, context, diagnostics) {
  if (!hasOwn(value, field)) return undefined;
  const fieldPath = `${inputPath}.${field}`;
  if (!isNumericInput(type)) {
    diagnostics.push(diagnostic(context, fieldPath, 'This field is only valid for numeric inputs.'));
    return undefined;
  }
  if (typeof value[field] === 'number' && Number.isFinite(value[field])) return value[field];
  diagnostics.push(diagnostic(context, fieldPath, 'Expected a finite number.'));
  return undefined;
}

function normalizeOptions(value, type, inputPath, context, diagnostics) {
  const optionPath = `${inputPath}.options`;
  if (!hasOwn(value, 'options')) {
    if (type === 'select' || type === 'radio') {
      diagnostics.push(diagnostic(context, optionPath, 'Expected a non-empty array of unique options.'));
    }
    return [];
  }
  if (type !== 'select' && type !== 'radio') {
    diagnostics.push(diagnostic(context, optionPath, 'This field is only valid for select and radio inputs.'));
    return [];
  }
  if (!Array.isArray(value.options) || value.options.length === 0) {
    diagnostics.push(diagnostic(context, optionPath, 'Expected a non-empty array of unique options.'));
    return [];
  }

  const seen = new Set();
  return value.options.flatMap((option, index) => {
    const fieldPath = `${optionPath}[${index}]`;
    const normalized = normalizeOption(option, fieldPath, context, diagnostics);
    if (!normalized) return [];
    if (seen.has(normalized.value)) {
      diagnostics.push(
        diagnostic(context, `${fieldPath}.value`, `Duplicate option value ${JSON.stringify(normalized.value)}.`)
      );
      return [];
    }
    seen.add(normalized.value);
    return [normalized];
  });
}

function normalizeOption(option, fieldPath, context, diagnostics) {
  if (typeof option === 'string') {
    if (option.trim() !== '') return { label: option.trim(), value: option.trim() };
    diagnostics.push(diagnostic(context, fieldPath, 'Expected a non-empty string option.'));
    return undefined;
  }
  if (!isRecord(option)) {
    diagnostics.push(diagnostic(context, fieldPath, 'Expected a non-empty string or { label, value } mapping.'));
    return undefined;
  }

  diagnostics.push(...unknownFieldDiagnostics(option, optionFields, context, `${fieldPath}.`));
  const label = normalizeNonEmptyOptionString(option.label, `${fieldPath}.label`, context, diagnostics);
  const value = normalizeNonEmptyOptionString(option.value, `${fieldPath}.value`, context, diagnostics);
  return label && value ? { label, value } : undefined;
}

function normalizeNonEmptyOptionString(value, fieldPath, context, diagnostics) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  diagnostics.push(diagnostic(context, fieldPath, 'Expected a non-empty string.'));
  return undefined;
}

function validateNumericConstraints(input, metadata, inputPath, context, diagnostics) {
  if (!isNumericInput(input.type)) return;
  const hasValidFields = ['value', 'min', 'max', 'step'].every(
    (field) => !hasOwn(metadata, field) || (typeof metadata[field] === 'number' && Number.isFinite(metadata[field]))
  );
  const hasValidIntegerFlag = !hasOwn(metadata, 'integer') || typeof metadata.integer === 'boolean';
  const hasValidStep = input.step === undefined || input.step > 0;
  const hasOrderedBounds = input.min === undefined || input.max === undefined || input.min <= input.max;
  const isWithinMinimum = input.min === undefined || input.value >= input.min;
  const isWithinMaximum = input.max === undefined || input.value <= input.max;
  const integerFieldsArePortable =
    !input.integer ||
    ['value', 'min', 'max', 'step'].every((field) => input[field] === undefined || isPortableInteger(input[field]));

  if (!hasValidStep) {
    diagnostics.push(diagnostic(context, `${inputPath}.step`, 'Expected a number greater than zero.'));
  }
  if (!hasOrderedBounds) {
    diagnostics.push(diagnostic(context, `${inputPath}.min`, 'Expected min to be less than or equal to max.'));
  }
  if (!isWithinMinimum) {
    diagnostics.push(
      diagnostic(context, `${inputPath}.value`, 'Expected the default value to be greater than or equal to min.')
    );
  }
  if (!isWithinMaximum) {
    diagnostics.push(
      diagnostic(context, `${inputPath}.value`, 'Expected the default value to be less than or equal to max.')
    );
  }
  if (input.integer) {
    for (const field of ['value', 'min', 'max', 'step']) {
      if (input[field] !== undefined && !isPortableInteger(input[field])) {
        diagnostics.push(
          diagnostic(
            context,
            `${inputPath}.${field}`,
            `Expected a signed 32-bit integer from ${PORTABLE_INTEGER_MIN} through ${PORTABLE_INTEGER_MAX}.`
          )
        );
      }
    }
  }
  if (
    hasValidFields &&
    hasValidIntegerFlag &&
    hasValidStep &&
    hasOrderedBounds &&
    isWithinMinimum &&
    isWithinMaximum &&
    integerFieldsArePortable
  ) {
    const grid = numericStepGrid(input, input.value);
    if (grid.stepMismatch) {
      diagnostics.push(
        diagnostic(
          context,
          `${inputPath}.value`,
          `Expected the default value to align with effective step ${JSON.stringify(grid.effectiveStep)} from base ${JSON.stringify(grid.base)}.`
        )
      );
    }
  }
}

function validateOptionDefault(type, value, options, inputPath, context, diagnostics) {
  if (type !== 'select' && type !== 'radio') return;
  if (!options.some((option) => option.value === value)) {
    diagnostics.push(diagnostic(context, `${inputPath}.value`, 'Expected the default value to match an option value.'));
  }
}

function validateDependencyFields(metadata, language, packages, context, diagnostics) {
  if (hasOwn(metadata, 'packages') && language !== 'python') {
    diagnostics.push(
      diagnostic(context, 'packages', `This field is not supported for ${languageLabel(language)} cells.`)
    );
  }
  if (hasOwn(metadata, 'crates') && language !== 'rust') {
    diagnostics.push(
      diagnostic(context, 'crates', `This field is not supported for ${languageLabel(language)} cells.`)
    );
  }
  if (language === 'python') {
    packages.forEach((packageName, index) => {
      if (!supportedPyodidePackages.includes(packageName)) {
        diagnostics.push(
          diagnostic(
            context,
            `packages[${index}]`,
            `Unsupported Pyodide package ${JSON.stringify(packageName)}. Vendored packages: ${supportedPyodidePackages.join(', ')}.`
          )
        );
      }
    });
  }
}

function unknownFieldDiagnostics(value, allowedFields, context, prefix) {
  return Object.keys(value)
    .filter((field) => !allowedFields.has(field))
    .map((field) => diagnostic(context, `${prefix}${field}`, 'Unknown field.'));
}

function defaultInput(name) {
  return {
    name,
    type: 'text',
    label: name,
    value: '',
    min: undefined,
    max: undefined,
    step: undefined,
    integer: false,
    options: []
  };
}

function defaultInputValue(type) {
  if (type === 'checkbox') return false;
  if (isNumericInput(type)) return 0;
  return '';
}

function inputValueType(type) {
  if (type === 'checkbox') return 'a boolean';
  if (isNumericInput(type)) return 'a finite number';
  return 'a string';
}

function isNumericInput(type) {
  return type === 'range' || type === 'number' || type === 'integer';
}

function languageLabel(language) {
  if (language === 'rust') return 'Rust';
  if (language === 'python') return 'Python';
  if (language === 'haskell') return 'Haskell';
  return 'interactive';
}

function cellLocation(cell) {
  return `${cell.pagePath || '(unknown page)'}:${cell.fenceStartLine ?? 1}`;
}

function invalidResult(diagnostics) {
  return { kind: 'invalid', diagnostics };
}

function diagnostic(context, fieldPath, message) {
  const cellId = context.cellId ?? context.localId;
  return {
    pagePath: context.pagePath ?? '',
    fenceStartLine: context.fenceStartLine ?? 1,
    ...(cellId ? { cellId } : {}),
    fieldPath,
    message
  };
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
