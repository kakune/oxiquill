import { supportedPyodidePackages } from '../lib/doc-runtime/python-packages.mjs';

const metadataKey = Symbol.for('oxiquill.project-config');

export const oxiquillPathOptionNames = Object.freeze([
  'cacheDir',
  'cratesDir',
  'docsDir',
  'downloadCacheDir',
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
  const unknownFields = Object.keys(options).filter(
    (name) => !['offline', 'packageMirror', 'preload', 'additionalPackages'].includes(name)
  );
  if (unknownFields.length > 0) {
    throw new TypeError(`Unknown python option: ${unknownFields.sort().join(', ')}.`);
  }

  const preload = options.preload ?? false;
  if (typeof preload !== 'boolean') throw new TypeError('python.preload must be a boolean.');
  const offline = options.offline ?? false;
  if (typeof offline !== 'boolean') throw new TypeError('python.offline must be a boolean.');
  const packageMirror = normalizePackageMirror(options.packageMirror);
  const additionalPackages = normalizeAdditionalPackages(options.additionalPackages);
  return Object.freeze({
    offline,
    preload,
    ...(packageMirror ? { packageMirror } : {}),
    ...(additionalPackages ? { additionalPackages } : {})
  });
}

function normalizeAdditionalPackages(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('python.additionalPackages must be an object.');
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, notice]) => {
          const context = `python.additionalPackages.${name}`;
          if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(name) || supportedPyodidePackages.includes(name)) {
            throw new TypeError(`${context} must name an additional Pyodide lock package.`);
          }
          if (
            !notice ||
            typeof notice !== 'object' ||
            Array.isArray(notice) ||
            Object.keys(notice).some((key) => !['version', 'license', 'licenseFiles'].includes(key))
          ) {
            throw new TypeError(`${context} requires version, license, and licenseFiles.`);
          }
          for (const key of ['version', 'license']) {
            if (
              typeof notice[key] !== 'string' ||
              !notice[key].trim() ||
              /^(unknown|none|unlicensed)$/iu.test(notice[key].trim())
            ) {
              throw new TypeError(`${context}.${key} must contain known metadata.`);
            }
          }
          if (
            !Array.isArray(notice.licenseFiles) ||
            !notice.licenseFiles.length ||
            notice.licenseFiles.some((file) => typeof file !== 'string' || !file.trim()) ||
            new Set(notice.licenseFiles).size !== notice.licenseFiles.length
          ) {
            throw new TypeError(`${context}.licenseFiles must be a non-empty list of unique file paths.`);
          }
          return [
            name,
            Object.freeze({
              version: notice.version.trim(),
              license: notice.license.trim(),
              licenseFiles: Object.freeze([...notice.licenseFiles])
            })
          ];
        })
    )
  );
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
