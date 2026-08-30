import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathInUrl } from '../../config/paths.mjs';
import { vendoredPyodidePackageRoots } from './constants.mjs';
import { copyFileIfChanged, defaultFileSystem, hashFileSha256, hasPackageContent } from './file-system.mjs';
import { createSha256, hashBytes, stableFingerprint } from './hashing.mjs';

const require = createRequire(import.meta.url);
const defaultPackageCdn = 'https://cdn.jsdelivr.net/pyodide/';
const cacheNamespace = 'pyodide';
export const PYODIDE_DOWNLOAD_ATTEMPTS = 3;
export const PYODIDE_DOWNLOAD_CONCURRENCY = 4;
export const PYODIDE_REQUEST_TIMEOUT_MS = 30_000;
export const requiredPyodideFiles = [
  'pyodide.mjs',
  'pyodide.mjs.map',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json'
];

export async function resolvePyodideRuntimeInputs({
  fileSystem = defaultFileSystem,
  requestedPackages = vendoredPyodidePackageRoots,
  resolvePackageJson = resolvePyodidePackageJson
} = {}) {
  const packageDir = resolvePyodidePackageDir(resolvePackageJson);
  assertRequiredPyodideFiles(packageDir, { fileSystem });

  const packageJsonPath = path.join(packageDir, 'package.json');
  const lockPath = path.join(packageDir, 'pyodide-lock.json');
  const [packageMetadata, lockBytes] = await Promise.all([
    readJsonFile(packageJsonPath, { fileSystem }),
    fileSystem.readFile(lockPath)
  ]);
  const lockFile = parseJson(lockBytes, lockPath);
  const version = requiredText(packageMetadata.version, 'Pyodide package metadata is missing a version.');
  if (lockFile.info?.version !== undefined && lockFile.info.version !== version) {
    throw new Error(`Pyodide package version ${version} does not match lock file version ${lockFile.info.version}.`);
  }
  const lockSha256 = hashBytes(lockBytes);
  const coreAssets = await Promise.all(
    requiredPyodideFiles.map(async (fileName) => {
      const sourcePath = path.join(packageDir, fileName);
      return Object.freeze({ fileName, sha256: await hashFileSha256(sourcePath, { fileSystem }), sourcePath });
    })
  );
  const packages = resolveVendoredPyodidePackages(lockFile, requestedPackages);
  const fingerprint = stableFingerprint({
    core: coreAssets.map(({ fileName, sha256 }) => ({ fileName, sha256 })),
    lockSha256,
    packages: packages.map(({ depends, file_name: fileName, name, sha256, version: packageVersion }) => ({
      depends,
      fileName,
      name,
      sha256,
      version: packageVersion
    })),
    requestedPackages: Array.from(new Set(requestedPackages)).sort(),
    version
  });

  return Object.freeze({
    coreAssets: Object.freeze(coreAssets),
    defaultPackageBaseUrl: new URL(`v${version}/full/`, defaultPackageCdn).href,
    fingerprint,
    lockFile,
    lockSha256,
    packageDir,
    packages: Object.freeze(packages),
    version
  });
}

export async function copyPyodideAssets({
  fetchImplementation = globalThis.fetch,
  fetchPackage,
  fileSystem = defaultFileSystem,
  paths,
  pythonOptions = Object.freeze({ offline: false }),
  requestedPackages = vendoredPyodidePackageRoots,
  resolvePackageJson = resolvePyodidePackageJson,
  runtimeInputs,
  signal,
  sleep = defaultSleep,
  temporaryName = randomUUID
}) {
  const inputs =
    runtimeInputs ?? (await resolvePyodideRuntimeInputs({ fileSystem, requestedPackages, resolvePackageJson }));
  const packageBaseUrl = pythonOptions.packageMirror ?? inputs.defaultPackageBaseUrl;
  const cacheDirectory = pathInUrl(paths.downloadCacheDir, cacheNamespace, inputs.version, inputs.lockSha256);
  const assets = [
    ...inputs.coreAssets.map((asset) => ({ ...asset, kind: 'installed' })),
    ...inputs.packages.map((packageInfo) => ({
      fileName: packageInfo.file_name,
      kind: 'download',
      name: packageInfo.name,
      sha256: packageInfo.sha256
    }))
  ];

  const cachedAssets = await mapWithConcurrency(
    assets,
    PYODIDE_DOWNLOAD_CONCURRENCY,
    async (asset, _index, operationSignal) => ({
      ...asset,
      cachePath: await ensureCachedAsset(asset, {
        cacheDirectory,
        fetchImplementation,
        fetchPackage,
        fileSystem,
        offline: pythonOptions.offline,
        packageBaseUrl,
        signal: operationSignal,
        sleep,
        temporaryName
      })
    }),
    { signal }
  );
  const copied = [];
  for (const { cachePath, fileName } of cachedAssets) {
    copied.push(await copyFileIfChanged(cachePath, pathInUrl(paths.pyodidePublicDir, fileName), { fileSystem }));
  }
  return copied.some(Boolean);
}

export async function copyVendoredPyodidePackages({
  fetchImplementation = globalThis.fetch,
  fetchPackage,
  fileSystem = defaultFileSystem,
  lockFile,
  paths,
  pyodideVersion,
  roots = vendoredPyodidePackageRoots,
  signal,
  sleep = defaultSleep,
  temporaryName = randomUUID
}) {
  const version = requiredText(pyodideVersion, 'pyodideVersion is required when copying vendored packages.');
  const packages = resolveVendoredPyodidePackages(lockFile, roots);
  const runtimeInputs = {
    coreAssets: [],
    defaultPackageBaseUrl: new URL(`v${version}/full/`, defaultPackageCdn).href,
    lockSha256: hashBytes(Buffer.from(JSON.stringify(lockFile))),
    packages,
    version
  };
  return copyPyodideAssets({
    fetchImplementation,
    fetchPackage,
    fileSystem,
    paths,
    runtimeInputs,
    signal,
    sleep,
    temporaryName
  });
}

export function resolveVendoredPyodidePackages(lockFile, roots = vendoredPyodidePackageRoots) {
  const packages = lockFile?.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
    throw new Error('Pyodide lock file is missing a packages table.');
  }

  const selected = new Set();
  function visit(packageName) {
    if (selected.has(packageName)) return;
    const packageInfo = packages[packageName];
    if (!packageInfo) throw new Error(`Pyodide package "${packageName}" is missing from the lock file.`);
    validatePackageInfo(packageName, packageInfo);
    selected.add(packageName);
    (packageInfo.depends ?? []).forEach(visit);
  }

  roots.forEach(visit);
  return Array.from(selected)
    .sort()
    .map((name) => Object.freeze({ name, ...packages[name], depends: Object.freeze(packages[name].depends ?? []) }));
}

async function ensureCachedAsset(
  asset,
  {
    cacheDirectory,
    fetchImplementation,
    fetchPackage,
    fileSystem,
    offline,
    packageBaseUrl,
    signal,
    sleep,
    temporaryName
  }
) {
  const cachePath = path.join(cacheDirectory, asset.fileName);
  if (await hasPackageContent(cachePath, asset.sha256, { fileSystem })) return cachePath;
  if (offline) {
    throw new Error(
      `Offline Pyodide cache miss for "${asset.fileName}" at "${cachePath}"; expected sha256 ${asset.sha256}.`
    );
  }

  await fileSystem.mkdir(cacheDirectory, { recursive: true });
  const temporaryPath = `${cachePath}.tmp-${temporaryName()}`;
  try {
    if (asset.kind === 'installed') {
      await fileSystem.copyFile(asset.sourcePath, temporaryPath);
      await assertFileSha256(temporaryPath, asset.sha256, asset.name ?? asset.fileName, { fileSystem });
    } else {
      await downloadAssetToFile(asset, temporaryPath, {
        fetchImplementation,
        fetchPackage,
        fileSystem,
        packageBaseUrl,
        signal,
        sleep
      });
    }
    await publishVerifiedAsset(temporaryPath, cachePath, asset.sha256, { fileSystem, temporaryName });
    return cachePath;
  } finally {
    await fileSystem.rm(temporaryPath, { force: true });
  }
}

export async function fetchPyodidePackage(
  fileName,
  {
    fetchImplementation = globalThis.fetch,
    packageBaseUrl,
    consumeResponse = responseBytes,
    signal,
    sleep = defaultSleep,
    timeoutMs = PYODIDE_REQUEST_TIMEOUT_MS
  }
) {
  const url = new URL(encodeURIComponent(fileName), packageBaseUrl).href;
  let lastError;
  let attempts = 0;

  for (let attempt = 1; attempt <= PYODIDE_DOWNLOAD_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    try {
      return await fetchOnce(url, { consumeResponse, fetchImplementation, signal, timeoutMs });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === PYODIDE_DOWNLOAD_ATTEMPTS) break;
      await sleep(attempt === 1 ? 250 : 1_000);
    }
  }

  throw new Error(`Failed to download ${url} after ${attempts} attempt(s): ${errorMessage(lastError)}`, {
    cause: lastError
  });
}

async function fetchOnce(url, { consumeResponse, fetchImplementation, signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const abortRequest = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener('abort', abortRequest, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetchImplementation(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }
    return await consumeResponse(response, { signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(`request timed out after ${timeoutMs}ms`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (signal?.aborted) {
      const abortError = signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
      abortError.retryable = false;
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }
}

function isRetryable(error) {
  return error?.retryable !== false;
}

async function assertFileSha256(filePath, expectedSha256, assetName, { fileSystem }) {
  const actualSha256 = await hashFileSha256(filePath, { fileSystem });
  assertSha256(actualSha256, expectedSha256, assetName);
}

function assertSha256(actualSha256, expectedSha256, assetName) {
  if (actualSha256 !== expectedSha256) {
    const error = new Error(`Pyodide asset "${assetName}" has sha256 ${actualSha256}; expected ${expectedSha256}.`);
    error.retryable = false;
    throw error;
  }
}

async function downloadAssetToFile(
  asset,
  temporaryPath,
  { fetchImplementation, fetchPackage, fileSystem, packageBaseUrl, signal, sleep }
) {
  if (fetchPackage) {
    const content = await fetchPackage(asset.fileName);
    if (content?.body) {
      await streamResponseToFile(content, temporaryPath, asset, { fileSystem, signal });
    } else {
      await fileSystem.writeFile(temporaryPath, content);
      await assertFileSha256(temporaryPath, asset.sha256, asset.name ?? asset.fileName, { fileSystem });
    }
    return;
  }

  await fetchPyodidePackage(asset.fileName, {
    consumeResponse: (response, { signal: requestSignal }) =>
      streamResponseToFile(response, temporaryPath, asset, { fileSystem, signal: requestSignal }),
    fetchImplementation,
    packageBaseUrl,
    signal,
    sleep
  });
}

async function streamResponseToFile(response, temporaryPath, asset, { fileSystem, signal }) {
  if (!response.body) throw new Error(`Pyodide asset "${asset.name ?? asset.fileName}" has no response body.`);
  if (!fileSystem.open) throw new Error('The configured file system does not support streaming writes.');

  const hash = createSha256();
  await fileSystem.rm(temporaryPath, { force: true });
  const fileHandle = await fileSystem.open(temporaryPath, 'wx');
  try {
    try {
      for await (const chunk of response.body) {
        throwIfAborted(signal);
        const bytes = toBytes(chunk, asset.name ?? asset.fileName);
        hash.update(bytes);
        await writeAll(fileHandle, bytes);
      }
      throwIfAborted(signal);
    } finally {
      await fileHandle.close();
    }

    assertSha256(hash.digest('hex'), asset.sha256, asset.name ?? asset.fileName);
  } catch (error) {
    await fileSystem.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeAll(fileHandle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await fileHandle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new Error('Unable to make progress while writing a Pyodide asset.');
    offset += bytesWritten;
  }
}

function toBytes(chunk, assetName) {
  if (typeof chunk === 'string' || ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer) {
    return Buffer.from(chunk);
  }
  throw new TypeError(`Pyodide asset "${assetName}" returned a non-byte stream chunk.`);
}

async function publishVerifiedAsset(temporaryPath, cachePath, expectedSha256, { fileSystem, temporaryName }) {
  const displacedPaths = [];
  try {
    for (;;) {
      if (await linkOrVerify(temporaryPath, cachePath, expectedSha256, { fileSystem })) return;

      const displacedPath = `${cachePath}.corrupt-${temporaryName()}`;
      try {
        await fileSystem.rename(cachePath, displacedPath);
        displacedPaths.push(displacedPath);
      } catch (error) {
        if (!isFileSystemError(error, 'ENOENT')) throw error;
        continue;
      }

      if (
        (await hasPackageContent(displacedPath, expectedSha256, { fileSystem })) &&
        (await linkOrVerify(displacedPath, cachePath, expectedSha256, { fileSystem }))
      ) {
        return;
      }
    }
  } finally {
    await Promise.all(displacedPaths.map((filePath) => fileSystem.rm(filePath, { force: true })));
  }
}

async function linkOrVerify(sourcePath, cachePath, expectedSha256, { fileSystem }) {
  try {
    await fileSystem.link(sourcePath, cachePath);
    return true;
  } catch (error) {
    if (!isFileSystemError(error, 'EEXIST')) throw error;
  }
  return hasPackageContent(cachePath, expectedSha256, { fileSystem });
}

async function mapWithConcurrency(values, concurrency, mapper, { signal } = {}) {
  const results = new Array(values.length);
  const controller = new AbortController();
  let nextIndex = 0;
  let failure;
  const abortWorkers = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortWorkers();
  else signal?.addEventListener('abort', abortWorkers, { once: true });

  async function worker() {
    while (!controller.signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await mapper(values[index], index, controller.signal);
      } catch (error) {
        failure ??= error;
        controller.abort(error);
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  } finally {
    signal?.removeEventListener('abort', abortWorkers);
  }

  if (failure) throw failure;
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
  return results;
}

async function responseBytes(response, { signal }) {
  if (!response.body) return Buffer.from(await response.arrayBuffer());
  const chunks = [];
  for await (const chunk of response.body) {
    throwIfAborted(signal);
    chunks.push(toBytes(chunk, 'download'));
  }
  return Buffer.concat(chunks);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
}

function isFileSystemError(error, code) {
  return Boolean(error && error.code === code);
}

function resolvePyodidePackageJson() {
  return require.resolve('pyodide/package.json');
}

function resolvePyodidePackageDir(resolvePackageJson) {
  try {
    const packageJsonPath = resolvePackageJson();
    if (typeof packageJsonPath !== 'string' || packageJsonPath.length === 0) {
      throw new TypeError('The package resolver did not return a file path.');
    }
    return path.dirname(packageJsonPath);
  } catch (error) {
    throw new Error('Unable to resolve required Pyodide package "pyodide" from Oxiquill.', { cause: error });
  }
}

function assertRequiredPyodideFiles(packageDir, { fileSystem }) {
  requiredPyodideFiles.forEach((fileName) => {
    const filePath = path.join(packageDir, fileName);
    if (fileSystem.existsSync(filePath)) return;
    throw new Error(`Required Pyodide asset "${fileName}" is missing from package "pyodide" at "${filePath}".`);
  });
}

function validatePackageInfo(name, packageInfo) {
  const fileName = requiredText(packageInfo.file_name, `Pyodide package "${name}" is missing file_name.`);
  if (path.basename(fileName) !== fileName || fileName.includes('\\')) {
    throw new Error(`Pyodide package "${name}" has unsafe file_name "${fileName}".`);
  }
  if (!/^[0-9a-f]{64}$/u.test(packageInfo.sha256)) {
    throw new Error(`Pyodide package "${name}" has an invalid sha256.`);
  }
  if (packageInfo.depends !== undefined && !Array.isArray(packageInfo.depends)) {
    throw new Error(`Pyodide package "${name}" has invalid dependencies.`);
  }
}

async function readJsonFile(filePath, { fileSystem }) {
  return parseJson(await fileSystem.readFile(filePath), filePath);
}

function parseJson(source, filePath) {
  try {
    return JSON.parse(String(source));
  } catch (error) {
    throw new Error(`Pyodide metadata file is invalid: ${filePath}.`, { cause: error });
  }
}

function requiredText(value, message) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(message);
  return value.trim();
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
