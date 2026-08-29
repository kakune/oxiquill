import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { copyFileIfChanged, writeIfChanged } from './doc-runtime/file-system.mjs';

const defaultFileSystem = {
  copyFile,
  existsSync,
  mkdir,
  readFile,
  readdir,
  writeFile
};
const licenseDataUrl = new URL('./license-data/', import.meta.url);
const defaultLicenseDataDir =
  licenseDataUrl.protocol === 'file:'
    ? fileURLToPath(licenseDataUrl)
    : path.resolve(process.cwd(), 'packages/oxiquill/src/generator/license-data');
const bundledOverridesFile = 'bundled-package-overrides.json';
const runtimeManifestFile = 'runtime-artifacts.json';
const unknownLicensePattern = /^(?:none|unknown|unlicensed)$/iu;

export function createBundledModuleCollector() {
  const groups = new Map();

  return {
    add(source, moduleIds) {
      const current = groups.get(source) ?? new Set();
      moduleIds.forEach((moduleId) => current.add(moduleId));
      groups.set(source, current);
    },
    reset() {
      groups.clear();
    },
    snapshot() {
      return new Map(Array.from(groups, ([source, moduleIds]) => [source, Array.from(moduleIds).sort()]));
    }
  };
}

export function collectBundleModuleIds(bundle) {
  return Array.from(
    new Set(
      Object.values(bundle)
        .filter((output) => output.type === 'chunk')
        .flatMap((chunk) => Object.keys(chunk.modules ?? {}))
    )
  ).sort();
}

export function packageRootFromModuleId(moduleId) {
  const filePath = String(moduleId).replace(/^\0/u, '').split(/[?#]/u, 1)[0];
  const packagePattern = /[/\\]node_modules[/\\](?!\.pnpm[/\\])(?:@[^/\\]+[/\\])?[^/\\]+/gu;
  let match;
  let packageRoot;

  while ((match = packagePattern.exec(filePath)) !== null) {
    packageRoot = filePath.slice(0, match.index + match[0].length);
  }

  return packageRoot;
}

export async function collectBundledPackageNotices(
  moduleGroups,
  { fileSystem = defaultFileSystem, licenseDataDir = defaultLicenseDataDir, searchRoots = [] } = {}
) {
  const roots = new Map();

  for (const [source, moduleIds] of moduleGroups) {
    for (const moduleId of moduleIds) {
      const discoveredRoot = packageRootFromModuleId(moduleId);
      if (!discoveredRoot) continue;
      const packageRoot = resolvePackageRoot(discoveredRoot, { fileSystem, searchRoots });

      const sources = roots.get(packageRoot) ?? new Set();
      sources.add(`bundled JavaScript (${source})`);
      roots.set(packageRoot, sources);
    }
  }

  const results = await Promise.allSettled(
    Array.from(roots, async ([packageRoot, sources]) => {
      const packageJsonPath = path.join(packageRoot, 'package.json');
      const packageJson = await readJsonFile(packageJsonPath, { fileSystem });
      if (packageJson.name === 'oxiquill') return undefined;

      const name = assertKnownText(packageJson.name, `Package at ${packageRoot} is missing a name`);
      const version = assertKnownText(packageJson.version, `Package ${name} is missing a version`);
      const licenseText = await readPackageLicenseText(packageRoot, packageJson.license, {
        fileSystem,
        licenseDataDir,
        name,
        version
      });
      const license = resolvePackageLicense(packageJson.license, licenseText, name);

      return {
        license,
        licenseText,
        name,
        sources: Array.from(sources).sort(),
        version
      };
    })
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    const messages = failures.map(({ reason }) => (reason instanceof Error ? reason.message : String(reason))).sort();
    throw new AggregateError(
      failures.map(({ reason }) => reason),
      `Bundled package license collection failed:\n- ${messages.join('\n- ')}`
    );
  }
  const notices = results.map((result) => result.value);

  return mergeNotices(notices.filter(Boolean));
}

export async function collectRuntimeArtifactNotices({
  fileSystem = defaultFileSystem,
  licenseDataDir = defaultLicenseDataDir,
  manifest,
  paths
}) {
  const resolvedManifest =
    manifest ?? (await readJsonFile(path.join(licenseDataDir, runtimeManifestFile), { fileSystem }));
  if (resolvedManifest.schemaVersion !== 1 || !Array.isArray(resolvedManifest.artifacts)) {
    throw new Error('Runtime license manifest must use schemaVersion 1 and contain an artifacts array.');
  }

  const notices = await Promise.all(
    resolvedManifest.artifacts.map(async (artifact, index) => {
      const context = `Runtime license manifest artifact ${index + 1}`;
      const name = assertKnownText(artifact.name, `${context} is missing a name`);
      const version = assertKnownText(artifact.version, `${context} (${name}) is missing a version`);
      const license = assertKnownText(artifact.license, `${context} (${name}) has an unknown license`);
      const source = assertKnownText(artifact.source, `${context} (${name}) is missing a source`);
      const files = assertStringArray(artifact.files, `${context} (${name}) is missing copied file paths`);
      const licenseFiles = assertStringArray(
        artifact.licenseFiles,
        `${context} (${name}) is missing license text files`
      );
      const licenseText = await readManifestLicenseText(licenseFiles, { fileSystem, licenseDataDir, name });
      const included = files.some((filePath) => fileSystem.existsSync(runtimeArtifactPath(paths, filePath)));

      return included ? { license, licenseText, name, sources: [source], version } : undefined;
    })
  );

  return mergeNotices(notices.filter(Boolean));
}

function runtimeArtifactPath(paths, filePath) {
  const normalizedPath = String(filePath).replaceAll('\\', '/');
  const [directory, ...segments] = normalizedPath.split('/');
  const runtimeDirectories = {
    'haskell-wasm': paths.haskellWasmPublicDir,
    pyodide: paths.pyodidePublicDir,
    'rust-wasm': paths.rustWasmPublicDir
  };
  const configuredDirectory = runtimeDirectories[directory];
  return configuredDirectory
    ? pathInUrl(configuredDirectory, ...segments)
    : pathInUrl(paths.publicAssetsDir, normalizedPath);
}

export function generateThirdPartyLicenseReport(notices) {
  const merged = mergeNotices(notices);
  const introduction = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'This file is generated by Oxiquill. It covers third-party modules in the',
    'built main and worker bundles plus copied runtime artifacts. Consumer-authored',
    'content and optional helper crates are outside this report.',
    ''
  ];

  if (merged.length === 0) {
    return `${introduction.join('\n')}No third-party runtime artifacts were included.\n`;
  }

  const components = merged.map((notice) =>
    [
      `${notice.name} ${notice.version}`,
      `License: ${notice.license}`,
      `Included from: ${notice.sources.join(', ')}`
    ].join('\n')
  );
  const licenseTexts = groupLicenseTexts(merged).map((group) =>
    [
      '='.repeat(80),
      `Used by: ${group.packages.join(', ')}`,
      `License expression(s): ${group.licenses.join(', ')}`,
      '-'.repeat(80),
      group.licenseText.trim()
    ].join('\n')
  );

  return [
    introduction.join('\n'),
    'COMPONENTS',
    '-'.repeat(80),
    components.join('\n\n'),
    '',
    'LICENSE TEXTS',
    '',
    licenseTexts.join('\n\n'),
    ''
  ].join('\n');
}

export async function syncLicenseArtifacts({
  fileSystem = defaultFileSystem,
  includeRustBuildFiles = true,
  licenseDataDir = defaultLicenseDataDir,
  moduleGroups = new Map(),
  outputDirectory = /** @type {string | undefined} */ (undefined),
  paths
}) {
  const licensesDirectory = outputDirectory ?? pathFromUrl(paths.licensesPublicDir);
  const ownLicenseCopies = [
    ['LICENSE-MIT', pathInUrl(paths.frameworkRoot, 'LICENSE-MIT')],
    ['LICENSE-APACHE', pathInUrl(paths.frameworkRoot, 'LICENSE-APACHE')]
  ];
  const copied = await Promise.all(
    ownLicenseCopies.map(([fileName, sourcePath]) =>
      copyFileIfChanged(sourcePath, path.join(licensesDirectory, fileName), { fileSystem })
    )
  );

  if (!outputDirectory && includeRustBuildFiles) {
    copied.push(...(await syncRustBuildSupportFiles({ fileSystem, licenseDataDir, paths })));
  }

  const [runtimeNotices, bundleNotices] = await Promise.all([
    collectRuntimeArtifactNotices({ fileSystem, licenseDataDir, paths }),
    collectBundledPackageNotices(moduleGroups, {
      fileSystem,
      licenseDataDir,
      searchRoots: [pathFromUrl(paths.workspaceRoot), pathFromUrl(paths.frameworkRoot)]
    })
  ]);
  const reportChanged = await writeIfChanged(
    path.join(licensesDirectory, 'THIRD_PARTY_LICENSES.txt'),
    generateThirdPartyLicenseReport([...runtimeNotices, ...bundleNotices]),
    { fileSystem }
  );

  return copied.some(Boolean) || reportChanged;
}

export async function syncRustBuildSupportFiles({
  fileSystem = defaultFileSystem,
  licenseDataDir = defaultLicenseDataDir,
  paths
}) {
  const copies = await Promise.all([
    copyFileIfChanged(pathInUrl(paths.frameworkRoot, 'LICENSE-MIT'), pathInUrl(paths.rustCellsDir, 'LICENSE-MIT'), {
      fileSystem
    }),
    copyFileIfChanged(
      pathInUrl(paths.frameworkRoot, 'LICENSE-APACHE'),
      pathInUrl(paths.rustCellsDir, 'LICENSE-APACHE'),
      { fileSystem }
    ),
    copyFileIfChanged(
      path.join(licenseDataDir, 'rust/runtime-Cargo.lock'),
      pathInUrl(paths.rustCellsDir, 'Cargo.lock'),
      { fileSystem }
    )
  ]);
  return copies;
}

async function readPackageLicenseText(packageRoot, license, { fileSystem, licenseDataDir, name, version }) {
  const entries = await fileSystem.readdir(packageRoot);
  const referencedFile = /^SEE LICEN[CS]E IN (.+)$/iu.exec(license)?.[1];
  const licenseFiles = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry.name))
    .filter(
      (fileName) => /^(?:licen[cs]e|copying)(?:$|[._-])/iu.test(fileName) || /^notice(?:$|[._-])/iu.test(fileName)
    );

  if (referencedFile && !licenseFiles.includes(referencedFile)) licenseFiles.push(referencedFile);
  licenseFiles.sort();
  if (licenseFiles.length === 0) {
    return readBundledLicenseOverride({ fileSystem, licenseDataDir, license, name, packageRoot, version });
  }

  const texts = await Promise.all(
    licenseFiles.map(async (fileName) => ({
      fileName,
      text: assertKnownText(
        await fileSystem.readFile(path.join(packageRoot, fileName), 'utf8'),
        `Package license file ${path.join(packageRoot, fileName)} is empty`
      )
    }))
  );
  const uniqueTexts = texts.filter(
    ({ text }, index) => texts.findIndex((candidate) => candidate.text === text) === index
  );

  return uniqueTexts.map(({ fileName, text }) => `[${fileName}]\n${text.trim()}`).join('\n\n');
}

async function readBundledLicenseOverride({ fileSystem, licenseDataDir, license, name, packageRoot, version }) {
  let manifest;
  try {
    manifest = await readJsonFile(path.join(licenseDataDir, bundledOverridesFile), { fileSystem });
  } catch {
    throw new Error(`Package license text is missing for ${packageRoot}.`);
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
    throw new Error('Bundled package license overrides must use schemaVersion 1 and contain a packages array.');
  }

  const override = manifest.packages.find((entry) => entry.name === name && entry.version === version);
  if (!override) throw new Error(`Package license text is missing for ${packageRoot}.`);

  const overrideLicense = assertKnownText(
    override.license,
    `Bundled package override for ${name} has an unknown license`
  );
  if (typeof license === 'string' && license.trim() && license.trim() !== overrideLicense) {
    throw new Error(`Bundled package override for ${name} ${version} conflicts with package license ${license}.`);
  }
  const licenseFile = assertKnownText(
    override.licenseFile,
    `Bundled package override for ${name} is missing a license file`
  );
  const text = await fileSystem.readFile(path.join(licenseDataDir, licenseFile), 'utf8');
  return `[${licenseFile}]\n${assertKnownText(text, `Bundled package override license text for ${name} is empty`)}`;
}

function resolvePackageLicense(value, licenseText, packageName) {
  if (typeof value === 'string' && value.trim() !== '' && !unknownLicensePattern.test(value.trim())) {
    return value.trim();
  }
  if (typeof value === 'string' && /^unlicensed$/iu.test(value.trim())) {
    throw new Error(`Package ${packageName} is marked as unlicensed.`);
  }

  const inferred = [
    [/Mozilla Public License Version 2\.0/iu, 'MPL-2.0'],
    [/Apache License\s+Version 2\.0/iu, 'Apache-2.0'],
    [/Permission is hereby granted, free of charge, to any person obtaining\s+a\s+copy/iu, 'MIT'],
    [/Redistribution and use in source and binary forms[\s\S]+Neither (?:the )?name/iu, 'BSD-3-Clause'],
    [/Permission to use, copy, modify, and\/or distribute this software/iu, 'ISC']
  ].find(([pattern]) => pattern.test(licenseText))?.[1];

  if (!inferred) throw new Error(`Package ${packageName} has unknown license text.`);
  return inferred;
}

async function readManifestLicenseText(licenseFiles, { fileSystem, licenseDataDir, name }) {
  const texts = await Promise.all(
    licenseFiles.map(async (fileName) => {
      const filePath = path.join(licenseDataDir, fileName);
      let content;
      try {
        content = await fileSystem.readFile(filePath, 'utf8');
      } catch (error) {
        throw new Error(`License text ${fileName} is missing for runtime artifact ${name}.`, { cause: error });
      }
      const licenseText = fileName.endsWith('.json') ? licenseTextFromJson(content, fileName, name) : content;
      return `[${fileName}]\n${assertKnownText(licenseText, `License text ${fileName} for runtime artifact ${name} is empty`).trim()}`;
    })
  );

  return texts.join('\n\n');
}

function licenseTextFromJson(content, fileName, artifactName) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`License text ${fileName} for runtime artifact ${artifactName} is invalid JSON.`, { cause: error });
  }
  return parsed.licenseText;
}

async function readJsonFile(filePath, { fileSystem }) {
  let source;
  try {
    source = await fileSystem.readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`License metadata file is missing: ${filePath}.`, { cause: error });
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`License metadata file is invalid JSON: ${filePath}.`, { cause: error });
  }
}

function assertKnownText(value, message) {
  if (typeof value !== 'string' || value.trim() === '' || unknownLicensePattern.test(value.trim())) {
    throw new Error(`${message}.`);
  }
  return value.trim();
}

function assertStringArray(value, message) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item.trim() === '')
  ) {
    throw new Error(`${message}.`);
  }
  return Array.from(new Set(value.map((item) => item.trim()))).sort();
}

function mergeNotices(notices) {
  const merged = new Map();

  for (const notice of notices) {
    const key = `${notice.name}\0${notice.version}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...notice, sources: Array.from(new Set(notice.sources)).sort() });
      continue;
    }

    if (current.license !== notice.license || current.licenseText !== notice.licenseText) {
      throw new Error(`Conflicting license data for ${notice.name} ${notice.version}.`);
    }
    current.sources = Array.from(new Set([...current.sources, ...notice.sources])).sort();
  }

  return Array.from(merged.values()).sort(
    (left, right) => compareText(left.name, right.name) || compareText(left.version, right.version)
  );
}

function groupLicenseTexts(notices) {
  const groups = new Map();

  for (const notice of notices) {
    const current = groups.get(notice.licenseText) ?? {
      licenses: new Set(),
      licenseText: notice.licenseText,
      packages: []
    };
    current.licenses.add(notice.license);
    current.packages.push(`${notice.name} ${notice.version}`);
    groups.set(notice.licenseText, current);
  }

  return Array.from(groups.values(), (group) => ({
    ...group,
    licenses: Array.from(group.licenses).sort(),
    packages: group.packages.sort()
  })).sort((left, right) => compareText(left.packages[0], right.packages[0]));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolvePackageRoot(packageRoot, { fileSystem, searchRoots }) {
  if (path.isAbsolute(packageRoot)) return packageRoot;

  const ancestors = Array.from(new Set(searchRoots.flatMap((searchRoot) => pathAncestors(path.resolve(searchRoot)))));
  return (
    ancestors
      .map((ancestor) => path.resolve(ancestor, packageRoot))
      .find((candidate) => fileSystem.existsSync(path.join(candidate, 'package.json'))) ?? packageRoot
  );
}

function pathAncestors(startPath) {
  const ancestors = [];
  let current = startPath;

  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}
