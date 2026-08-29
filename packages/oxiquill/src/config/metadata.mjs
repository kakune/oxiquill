const metadataKey = Symbol.for('oxiquill.project-config');

export const oxiquillPathOptionNames = Object.freeze([
  'cacheDir',
  'cratesDir',
  'docsDir',
  'frameworkRoot',
  'generatedDir',
  'haskellCellsDir',
  'haskellWasmPublicDir',
  'licensesPublicDir',
  'publicAssetsDir',
  'publicDir',
  'pyodidePublicDir',
  'rustCellsDir',
  'rustWasmPublicDir',
  'workspaceRoot'
]);

export const astroDirectoryOptionNames = Object.freeze(['root', 'publicDir', 'cacheDir', 'outDir']);

export function createOxiquillIntegrationMetadata({ astro = {}, paths = {} } = {}) {
  return Object.freeze({
    kind: 'integration',
    cwd: process.cwd(),
    astro: normalizeSelectedOptions(astro, astroDirectoryOptionNames),
    astroExplicitFields: explicitFields(astro, astroDirectoryOptionNames),
    paths: normalizeSelectedOptions(paths, oxiquillPathOptionNames),
    pathExplicitFields: explicitFields(paths, oxiquillPathOptionNames)
  });
}

export function createOxiquillConfigMetadata({ astro = {} } = {}) {
  return Object.freeze({
    kind: 'config',
    cwd: process.cwd(),
    astro: normalizeSelectedOptions(astro, astroDirectoryOptionNames),
    astroExplicitFields: explicitFields(astro, astroDirectoryOptionNames)
  });
}

export function attachOxiquillMetadata(target, metadata) {
  Object.defineProperty(target, metadataKey, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false
  });
  return target;
}

export function readOxiquillMetadata(target) {
  return target && typeof target === 'object' ? target[metadataKey] : undefined;
}

function normalizeSelectedOptions(options, names) {
  const entries = names
    .filter((name) => Object.hasOwn(options, name) && options[name] !== undefined)
    .map((name) => [name, normalizeMetadataValue(options[name], name)]);
  return Object.freeze(Object.fromEntries(entries));
}

function explicitFields(options, names) {
  return Object.freeze(names.filter((name) => Object.hasOwn(options, name) && options[name] !== undefined));
}

function normalizeMetadataValue(value, fieldName) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') {
      throw new TypeError(`${fieldName} must be a path string or file URL.`);
    }
    return value.href;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${fieldName} must be a path string or file URL.`);
  }
  if (value.trim() === '') {
    throw new TypeError(`${fieldName} must not be empty.`);
  }
  if (value.includes('://') && !value.startsWith('file:')) {
    throw new TypeError(`${fieldName} must be a path string or file URL.`);
  }

  return value;
}
