import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathInUrl } from '../../config/paths.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

const runtimeInputsUrl = new URL('../runtime-data/runtime-inputs.json', import.meta.url);
const rustLockUrl = new URL('../license-data/rust/runtime-Cargo.lock', import.meta.url);
const defaultRuntimeInputsPath =
  runtimeInputsUrl.protocol === 'file:'
    ? fileURLToPath(runtimeInputsUrl)
    : path.resolve(process.cwd(), 'packages/oxiquill/src/generator/runtime-data/runtime-inputs.json');
const defaultRustLockPath =
  rustLockUrl.protocol === 'file:'
    ? fileURLToPath(rustLockUrl)
    : path.resolve(process.cwd(), 'packages/oxiquill/src/generator/license-data/rust/runtime-Cargo.lock');

export async function readRuntimeInputs({
  fileSystem = defaultFileSystem,
  paths,
  runtimeInputsPath = defaultRuntimeInputsPath,
  rustLockPath = defaultRustLockPath
}) {
  const [packageSource, runtimeSource, rustLock] = await Promise.all([
    fileSystem.readFile(pathInUrl(paths.frameworkRoot, 'package.json'), 'utf8'),
    fileSystem.readFile(runtimeInputsPath, 'utf8'),
    fileSystem.readFile(rustLockPath, 'utf8')
  ]);

  return normalizeRuntimeInputs({
    packageJson: parseJson(packageSource, pathInUrl(paths.frameworkRoot, 'package.json')),
    runtimeData: parseJson(runtimeSource, runtimeInputsPath),
    rustLock: String(rustLock)
  });
}

export function normalizeRuntimeInputs({ packageJson, runtimeData, rustLock }) {
  if (runtimeData?.schemaVersion !== 1) {
    throw new Error('Oxiquill runtime inputs must use schemaVersion 1.');
  }

  const packageVersion = requiredText(packageJson?.version, 'Oxiquill package metadata is missing a version.');
  const repository = normalizeRepository(packageJson?.repository);
  const rust = normalizeRustInputs(runtimeData.rust);
  const haskell = normalizeHaskellInputs(runtimeData.haskell);
  assertRustLock(rustLock, { packageVersion, rust });

  return Object.freeze({
    haskell,
    package: Object.freeze({ repository, version: packageVersion }),
    rust,
    rustLock,
    rustLockSha256: hashBytes(Buffer.from(rustLock))
  });
}

export function normalizeRepository(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  const value = requiredText(raw, 'Oxiquill package metadata is missing a repository URL.')
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '');
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Oxiquill repository URL is invalid: ${value}.`, { cause: error });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Oxiquill repository URL must use HTTP(S): ${value}.`);
  }
  return url.href.replace(/\/$/u, '');
}

function normalizeRustInputs(value) {
  const dependencies = value?.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error('Oxiquill Rust runtime inputs are missing dependencies.');
  }

  const normalizedDependencies = Object.freeze(
    Object.fromEntries(
      Object.entries(dependencies)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, version]) => [name, requiredText(version, `Rust dependency ${name} is missing a version.`)])
    )
  );

  return Object.freeze({
    cargoVersion: requiredText(value.cargoVersion, 'Rust runtime inputs are missing cargoVersion.'),
    dependencies: normalizedDependencies,
    edition: requiredText(value.edition, 'Rust runtime inputs are missing edition.'),
    rustVersion: requiredText(value.rustVersion, 'Rust runtime inputs are missing rustVersion.'),
    rustcVersion: requiredText(value.rustcVersion, 'Rust runtime inputs are missing rustcVersion.'),
    target: requiredText(value.target, 'Rust runtime inputs are missing target.'),
    wasmPackVersion: requiredText(value.wasmPackVersion, 'Rust runtime inputs are missing wasmPackVersion.')
  });
}

function normalizeHaskellInputs(value) {
  return Object.freeze({
    compiler: requiredText(value?.compiler, 'Haskell runtime inputs are missing compiler.'),
    supportedVersionPrefix: requiredText(
      value?.supportedVersionPrefix,
      'Haskell runtime inputs are missing supportedVersionPrefix.'
    )
  });
}

function assertRustLock(rustLock, { packageVersion, rust }) {
  const lock = requiredText(rustLock, 'The generated Rust Cargo.lock input is empty.');
  const packageBlock = lock.match(/\[\[package\]\]\nname = "doc-rust-cells"\nversion = "([^"]+)"/u);
  if (packageBlock?.[1] !== packageVersion) {
    throw new Error(
      `Generated Rust Cargo.lock has doc-rust-cells ${packageBlock?.[1] ?? '(missing)'}; expected ${packageVersion}.`
    );
  }

  Object.entries(rust.dependencies).forEach(([name, version]) => {
    const escapedName = escapeRegExp(name);
    const escapedVersion = escapeRegExp(version);
    if (new RegExp(`name = "${escapedName}"\\nversion = "${escapedVersion}"`, 'u').test(lock)) return;
    throw new Error(`Generated Rust Cargo.lock is missing ${name} ${version}.`);
  });
}

function parseJson(source, filePath) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Oxiquill runtime metadata is invalid JSON: ${path.resolve(filePath)}.`, { cause: error });
  }
}

function requiredText(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
