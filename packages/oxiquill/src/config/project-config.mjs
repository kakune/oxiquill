import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { canonicalPath, createOxiquillPaths, directoryPath } from './paths.mjs';
import { astroDirectoryOptionNames, readOxiquillMetadata } from './metadata.mjs';
import { validateProjectPathSafety } from './path-safety.mjs';

const astroConfigFileNames = Object.freeze([
  'astro.config.mjs',
  'astro.config.js',
  'astro.config.ts',
  'astro.config.mts'
]);

export async function loadOxiquillProjectConfig({ cwd = process.cwd(), configFile } = {}) {
  const invocationCwd = path.resolve(pathFromConfigValue(cwd, process.cwd(), 'cwd'));
  const resolvedConfigFile = resolveAstroConfigFile({ cwd: invocationCwd, configFile });
  let loaded;

  try {
    loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'development' },
      resolvedConfigFile,
      invocationCwd,
      undefined,
      undefined,
      'runner'
    );
  } catch (error) {
    throw new Error(`Unable to load Oxiquill project config from ${resolvedConfigFile}.`, { cause: error });
  }

  if (!loaded) {
    throw new Error(`Unable to load Oxiquill project config from ${resolvedConfigFile}.`);
  }

  const integrationEntries = flattenIntegrations(loaded.config.integrations)
    .map((integration) => ({ integration, metadata: readOxiquillMetadata(integration) }))
    .filter(({ metadata }) => metadata?.kind === 'integration');

  if (integrationEntries.length === 0) {
    throw new Error(
      `Astro config ${resolvedConfigFile} does not contain an Oxiquill integration. ` +
        'Use defineOxiquillConfig() or oxiquillIntegration().'
    );
  }
  if (integrationEntries.length > 1) {
    throw new Error(
      `Astro config ${resolvedConfigFile} contains ${integrationEntries.length} Oxiquill integrations; expected exactly one.`
    );
  }

  const configMetadata = readOxiquillMetadata(loaded.config);
  const integrationMetadata = integrationEntries[0].metadata;
  const astroExplicitFields =
    configMetadata?.kind === 'config'
      ? configMetadata.astroExplicitFields
      : astroDirectoryOptionNames.filter(
          (fieldName) => Object.hasOwn(loaded.config, fieldName) && loaded.config[fieldName] !== undefined
        );

  return resolveOxiquillProjectConfig({
    astroConfig: loaded.config,
    astroExplicitFields,
    configFile: loaded.path ?? resolvedConfigFile,
    cwd: invocationCwd,
    integrationMetadata
  });
}

export function resolveOxiquillProjectConfig({
  astroConfig = {},
  astroExplicitFields = /** @type {string[]} */ ([]),
  configFile = undefined,
  cwd = process.cwd(),
  integrationMetadata
}) {
  if (integrationMetadata?.kind !== 'integration') {
    throw new TypeError('Expected normalized Oxiquill integration metadata.');
  }

  const invocationCwd = canonicalPath(pathFromConfigValue(cwd, process.cwd(), 'cwd'));
  const explicitAstroFields = new Set([...astroExplicitFields, ...integrationMetadata.astroExplicitFields]);
  const explicitPathFields = new Set(integrationMetadata.pathExplicitFields);
  const astroOptions = {
    ...integrationMetadata.astro,
    ...Object.fromEntries(
      astroDirectoryOptionNames
        .filter((fieldName) => astroConfig[fieldName] !== undefined)
        .map((fieldName) => [fieldName, astroConfig[fieldName]])
    )
  };
  const pathOptions = integrationMetadata.paths;
  const workspaceRoot = reconcileDirectory({
    astroField: 'root',
    astroOptions,
    astroExplicitFields: explicitAstroFields,
    basePath: invocationCwd,
    defaultValue: invocationCwd,
    pathField: 'workspaceRoot',
    pathOptions,
    pathExplicitFields: explicitPathFields
  });
  const publicDir = reconcileDirectory({
    astroField: 'publicDir',
    astroOptions,
    astroExplicitFields: explicitAstroFields,
    basePath: workspaceRoot,
    defaultValue: 'public',
    pathField: 'publicDir',
    pathOptions,
    pathExplicitFields: explicitPathFields
  });
  const cacheDir = reconcileDirectory({
    astroField: 'cacheDir',
    astroOptions,
    astroExplicitFields: explicitAstroFields,
    basePath: workspaceRoot,
    defaultValue: '.oxiquill',
    pathField: 'cacheDir',
    pathOptions,
    pathExplicitFields: explicitPathFields
  });
  const outDir = directoryPath(explicitAstroFields.has('outDir') ? astroOptions.outDir : 'dist', workspaceRoot);
  const paths = createOxiquillPaths({
    ...pathOptions,
    workspaceRoot,
    publicDir,
    cacheDir,
    outDir
  });

  const resolvedConfigFile = configFile
    ? path.resolve(pathFromConfigValue(configFile, invocationCwd, 'configFile'))
    : undefined;
  validateProjectPathSafety({ configFile: resolvedConfigFile, paths });
  const astroConfigArgs = resolvedConfigFile
    ? Object.freeze(['--root', paths.workspaceRoot, '--config', path.relative(paths.workspaceRoot, resolvedConfigFile)])
    : Object.freeze(['--root', paths.workspaceRoot]);

  return Object.freeze({
    astroConfigArgs,
    configFile: resolvedConfigFile,
    cwd: invocationCwd,
    paths,
    python: integrationMetadata.python
  });
}

export function resolveAstroConfigFile({ cwd = process.cwd(), configFile } = {}) {
  if (configFile !== undefined) {
    const resolved = path.resolve(pathFromConfigValue(configFile, cwd, 'configFile'));
    if (!existsSync(resolved)) {
      throw new Error(`Astro config file was not found: ${resolved}.`);
    }
    return resolved;
  }

  const resolved = astroConfigFileNames
    .map((fileName) => path.join(cwd, fileName))
    .find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error(
      `No Astro config was found in ${cwd}. Expected ${astroConfigFileNames.join(', ')} or --config <path>.`
    );
  }

  return resolved;
}

function reconcileDirectory({
  astroField,
  astroOptions,
  astroExplicitFields,
  basePath,
  defaultValue,
  pathField,
  pathOptions,
  pathExplicitFields
}) {
  const astroExplicit = astroExplicitFields.has(astroField) && astroOptions[astroField] !== undefined;
  const pathExplicit = pathExplicitFields.has(pathField) && pathOptions[pathField] !== undefined;
  const astroPath = astroExplicit ? directoryPath(astroOptions[astroField], basePath) : undefined;
  const oxiquillPath = pathExplicit ? directoryPath(pathOptions[pathField], basePath) : undefined;

  if (astroPath && oxiquillPath && astroPath !== oxiquillPath) {
    throw new Error(
      `Conflicting project paths: ${astroField} resolves to ${astroPath}, ` +
        `but paths.${pathField} resolves to ${oxiquillPath}.`
    );
  }

  return astroPath ?? oxiquillPath ?? directoryPath(defaultValue, basePath);
}

function flattenIntegrations(value) {
  if (!Array.isArray(value)) return value ? [value] : [];
  return value.flatMap((entry) => flattenIntegrations(entry));
}

function pathFromConfigValue(value, basePath, fieldName) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new TypeError(`${fieldName} must be a path or file URL.`);
    return fileURLToPath(value);
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${fieldName} must be a non-empty path or file URL.`);
  }
  if (value.startsWith('file:')) {
    const url = new URL(value);
    if (url.protocol !== 'file:') throw new TypeError(`${fieldName} must be a path or file URL.`);
    return fileURLToPath(url);
  }

  return path.isAbsolute(value) ? value : path.resolve(basePath, value);
}
