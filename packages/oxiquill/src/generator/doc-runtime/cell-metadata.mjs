import {
  inputTypes,
  runModes,
  supportedPyodidePackages
} from './constants.mjs';

export function normalizeRunMode(value, cellId = 'cell', pagePath = 'page') {
  if (value == null) return 'button';
  if (runModes.includes(value)) return value;

  throw new Error(
    `Interactive cell "${cellId}" in ${pagePath} has invalid run value ${JSON.stringify(value)}. ` +
      `Allowed values: ${runModes.join(', ')}.`
  );
}

export function normalizeTimeout(value, cellId = 'cell', pagePath = 'page') {
  if (value == null) return 30_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Interactive cell "${cellId}" in ${pagePath} has invalid timeoutMs value ${JSON.stringify(value)}. ` +
        'Expected a positive number.'
    );
  }

  return Math.trunc(value);
}

export function normalizePackages(value, language, cellId, pagePath) {
  if (value == null) return [];
  if (language !== 'python') {
    throw new Error(`Rust cell "${cellId}" in ${pagePath} must use crates instead of packages.`);
  }

  const packages = normalizeStringArray(value, 'packages', cellId, pagePath);
  const unsupportedPackages = packages.filter((packageName) => !supportedPyodidePackages.includes(packageName));
  if (unsupportedPackages.length > 0) {
    throw new Error(
      `Python cell "${cellId}" in ${pagePath} specifies unsupported packages: ${unsupportedPackages.join(', ')}. ` +
        `Vendored packages: ${supportedPyodidePackages.join(', ')}.`
    );
  }

  return packages;
}

export function normalizeCrates(value, language, cellId, pagePath, helperCrates) {
  if (value == null) return [];
  if (language !== 'rust') {
    throw new Error(`Non-Rust cell "${cellId}" in ${pagePath} cannot specify crates.`);
  }

  const crates = normalizeStringArray(value, 'crates', cellId, pagePath);
  for (const crateName of crates) {
    if (!helperCrates.has(crateName)) {
      const validCrates = Array.from(helperCrates.keys()).join(', ') || '(none)';
      throw new Error(
        `Rust cell "${cellId}" in ${pagePath} references unknown crate "${crateName}". ` +
          `Expected a helper crate under crates/. Available crates: ${validCrates}.`
      );
    }
  }

  return crates;
}

export function normalizeStringArray(value, field, cellId, pagePath) {
  if (!Array.isArray(value)) {
    throw new Error(`Interactive cell "${cellId}" in ${pagePath} has invalid ${field}; expected an array.`);
  }

  const values = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(
        `Interactive cell "${cellId}" in ${pagePath} has invalid ${field}; values must be non-empty strings.`
      );
    }
    values.add(raw.trim());
  }

  return Array.from(values).sort();
}

export function normalizeInputs(inputs, cellId = 'cell', pagePath = 'page') {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return [];

  return Object.entries(inputs).map(([name, raw]) => {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
    const type = normalizeInputType(value.type, name, cellId, pagePath);

    return {
      name,
      type,
      label: String(value.label ?? name),
      value: normalizeInputValue(type, value.value),
      min: normalizeOptionalNumber(value.min),
      max: normalizeOptionalNumber(value.max),
      step: normalizeOptionalNumber(value.step),
      integer: value.integer === true || type === 'integer',
      options: normalizeOptions(value.options)
    };
  });
}

export function normalizeInputType(type, inputName = 'input', cellId = 'cell', pagePath = 'page') {
  if (type == null) return 'text';
  if (inputTypes.includes(type)) return type;

  throw new Error(
    `Interactive cell "${cellId}" in ${pagePath} has invalid type ${JSON.stringify(type)} ` +
      `for input "${inputName}". Allowed values: ${inputTypes.join(', ')}.`
  );
}

export function normalizeInputValue(type, value) {
  if (type === 'checkbox') return Boolean(value);
  if (type === 'range' || type === 'number') return typeof value === 'number' ? value : 0;
  if (type === 'integer') return typeof value === 'number' ? Math.trunc(value) : 0;
  return value == null ? '' : String(value);
}

export function normalizeOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (option && typeof option === 'object') {
      return {
        label: String(option.label ?? option.value),
        value: String(option.value ?? option.label)
      };
    }

    return { label: String(option), value: String(option) };
  });
}
