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

export function createOxiquillIntegrationMetadata({ astro = {}, paths = {}, python = {} } = {}) {
  return Object.freeze({
    kind: 'integration',
    cwd: process.cwd(),
    astro: normalizeSelectedOptions(astro, astroDirectoryOptionNames),
    astroExplicitFields: explicitFields(astro, astroDirectoryOptionNames),
    paths: normalizeSelectedOptions(paths, oxiquillPathOptionNames),
    pathExplicitFields: explicitFields(paths, oxiquillPathOptionNames),
    python: normalizePythonOptions(python)
  });
}

function normalizePythonOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('python must be an object.');
  }
  const unknownFields = Object.keys(options).filter((name) => name !== 'offline' && name !== 'packageMirror');
  if (unknownFields.length > 0) {
    throw new TypeError(`Unknown python option: ${unknownFields.sort().join(', ')}.`);
  }

  const offline = options.offline ?? false;
  if (typeof offline !== 'boolean') throw new TypeError('python.offline must be a boolean.');
  const packageMirror = normalizePackageMirror(options.packageMirror);
  return Object.freeze({ offline, ...(packageMirror ? { packageMirror } : {}) });
}

function normalizePackageMirror(value) {
  if (value === undefined) return undefined;
  let url;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new TypeError('python.packageMirror must be an absolute HTTP(S) URL.', { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('python.packageMirror must be an absolute HTTP(S) URL.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError('python.packageMirror must not contain credentials, a query, or a fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
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
