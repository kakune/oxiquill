// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyPyodideAssets,
  createDocRuntimePaths,
  fetchPyodidePackage,
  hashBytes,
  PYODIDE_DOWNLOAD_ATTEMPTS,
  PYODIDE_DOWNLOAD_CONCURRENCY,
  PYODIDE_REQUEST_TIMEOUT_MS,
  requiredPyodideFiles,
  resolvePyodideRuntimeInputs
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';
import { cleanOxiquillWorkspace } from '../../packages/oxiquill/src/generator/clean.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';

const fixtureVersion = 'test-release';
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('Pyodide assets', () => {
  it('derives a deterministic release, package graph, and hashes from installed metadata', async () => {
    const fixture = await createInstalledPyodide();

    const first = await resolvePyodideRuntimeInputs({
      requestedPackages: ['root'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const second = await resolvePyodideRuntimeInputs({
      requestedPackages: ['root'],
      resolvePackageJson: fixture.resolvePackageJson
    });

    expect(first).toMatchObject({
      defaultPackageBaseUrl: `https://cdn.jsdelivr.net/pyodide/v${fixtureVersion}/full/`,
      version: fixtureVersion
    });
    expect(first.coreAssets.map(({ fileName }) => fileName)).toEqual(requiredPyodideFiles);
    expect(first.packages.map(({ name }) => name)).toEqual(['dependency', 'root']);
    expect(first.lockSha256).toBe(hashBytes(await readFile(fixture.lockPath)));
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it('uses a mirror, repairs corrupt entries online, and serves only verified cached assets offline', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['root'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const fetchedUrls = [];
    const fetchImplementation = vi.fn(async (url) => {
      fetchedUrls.push(String(url));
      const content = fixture.wheels[path.basename(new URL(url).pathname)];
      return response(content);
    });
    const options = {
      fetchImplementation,
      paths,
      pythonOptions: { offline: false, packageMirror: 'https://mirror.example/packages/' },
      requestedPackages: ['root'],
      runtimeInputs
    };

    await expect(copyPyodideAssets(options)).resolves.toBe(true);
    expect(fetchedUrls.sort()).toEqual([
      'https://mirror.example/packages/dependency.whl',
      'https://mirror.example/packages/root.whl'
    ]);

    const cacheDirectory = path.join(paths.downloadCacheDir, 'pyodide', fixtureVersion, runtimeInputs.lockSha256);
    expect(await readFile(path.join(cacheDirectory, 'root.whl'))).toEqual(fixture.wheels['root.whl']);

    await cleanOxiquillWorkspace({ paths });
    expect(await readFile(path.join(cacheDirectory, 'root.whl'))).toEqual(fixture.wheels['root.whl']);
    await rm(paths.pyodidePublicDir, { force: true, recursive: true });
    const offlineFetch = vi.fn();
    await expect(
      copyPyodideAssets({
        ...options,
        fetchImplementation: offlineFetch,
        pythonOptions: { offline: true }
      })
    ).resolves.toBe(true);
    expect(offlineFetch).not.toHaveBeenCalled();

    await writeFile(path.join(cacheDirectory, 'root.whl'), 'corrupt');
    await rm(paths.pyodidePublicDir, { force: true, recursive: true });
    const corruptOfflineFetch = vi.fn();
    await expect(
      copyPyodideAssets({
        ...options,
        fetchImplementation: corruptOfflineFetch,
        pythonOptions: { offline: true }
      })
    ).rejects.toThrow(
      `Offline Pyodide cache miss for "root.whl" at "${path.join(cacheDirectory, 'root.whl')}"; expected sha256 ${hashBytes(fixture.wheels['root.whl'])}.`
    );
    expect(corruptOfflineFetch).not.toHaveBeenCalled();

    await expect(copyPyodideAssets(options)).resolves.toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(cacheDirectory, 'root.whl'))).toEqual(fixture.wheels['root.whl']);
  });

  it('streams chunks to disk while incrementally verifying the checksum', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const chunks = [Buffer.from('dependency '), Buffer.from('wheel')];
    const writeSizes = [];
    const fileSystem = {
      ...defaultFileSystem,
      open: async (...arguments_) => {
        const fileHandle = await defaultFileSystem.open(...arguments_);
        return {
          close: () => fileHandle.close(),
          write: async (buffer, offset, length) => {
            writeSizes.push(length);
            return fileHandle.write(buffer, offset, length);
          }
        };
      }
    };
    const arrayBuffer = vi.fn(() => {
      throw new Error('arrayBuffer must not be used while staging assets');
    });

    await expect(
      copyPyodideAssets({
        fetchImplementation: async () => ({
          arrayBuffer,
          body: ReadableStream.from(chunks),
          ok: true,
          status: 200,
          statusText: 'ok'
        }),
        fileSystem,
        paths,
        requestedPackages: ['dependency'],
        runtimeInputs
      })
    ).resolves.toBe(true);

    expect(writeSizes).toEqual(chunks.map((chunk) => chunk.length));
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(await readFile(path.join(paths.pyodidePublicDir, 'dependency.whl'))).toEqual(Buffer.concat(chunks));
  });

  it('never exceeds the shared download concurrency limit', async () => {
    const fixture = await createInstalledPyodide({ packageCount: PYODIDE_DOWNLOAD_CONCURRENCY * 2 + 1 });
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const packageNames = Object.keys(fixture.wheels).map((fileName) => path.basename(fileName, '.whl'));
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: packageNames,
      resolvePackageJson: fixture.resolvePackageJson
    });
    let active = 0;
    let maximumActive = 0;
    let releaseFirstBatch;
    const firstBatch = new Promise((resolve) => {
      releaseFirstBatch = resolve;
    });

    await copyPyodideAssets({
      fetchImplementation: async (url) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (active === PYODIDE_DOWNLOAD_CONCURRENCY) releaseFirstBatch();
        const content = fixture.wheels[path.basename(new URL(url).pathname)];
        return {
          body: {
            async *[Symbol.asyncIterator]() {
              try {
                await firstBatch;
                yield content;
              } finally {
                active -= 1;
              }
            }
          },
          ok: true,
          status: 200,
          statusText: 'ok'
        };
      },
      paths,
      requestedPackages: packageNames,
      runtimeInputs
    });

    expect(maximumActive).toBe(PYODIDE_DOWNLOAD_CONCURRENCY);
    expect(active).toBe(0);
  });

  it('retries a mid-stream failure from a clean temporary file', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(streamFailureResponse(Buffer.from('partial')))
      .mockResolvedValueOnce(response(fixture.wheels['dependency.whl']));

    await expect(
      copyPyodideAssets({
        fetchImplementation,
        paths,
        requestedPackages: ['dependency'],
        runtimeInputs,
        sleep: async () => {}
      })
    ).resolves.toBe(true);

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(await readFile(path.join(paths.pyodidePublicDir, 'dependency.whl'))).toEqual(
      fixture.wheels['dependency.whl']
    );
    await expectNoTemporaryCacheFiles(paths, runtimeInputs);
  });

  it('cleans partial files after a terminal mid-stream failure', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const fetchImplementation = vi.fn(async () => streamFailureResponse(Buffer.from('partial')));

    await expect(
      copyPyodideAssets({
        fetchImplementation,
        paths,
        requestedPackages: ['dependency'],
        runtimeInputs,
        sleep: async () => {}
      })
    ).rejects.toThrow('stream interrupted');

    expect(fetchImplementation).toHaveBeenCalledTimes(PYODIDE_DOWNLOAD_ATTEMPTS);
    await expectNoTemporaryCacheFiles(paths, runtimeInputs);
    await expect(readFile(path.join(paths.pyodidePublicDir, 'dependency.whl'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('aborts active streams and removes every partial file before rejecting', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const controller = new AbortController();
    let streamStarted;
    const started = new Promise((resolve) => {
      streamStarted = resolve;
    });
    const fetchImplementation = vi.fn(async (_url, { signal }) => ({
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('partial');
          streamStarted();
          await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason ?? new Error('request aborted')), {
              once: true
            });
          });
        }
      },
      ok: true,
      status: 200,
      statusText: 'ok'
    }));
    const operation = copyPyodideAssets({
      fetchImplementation,
      paths,
      requestedPackages: ['dependency'],
      runtimeInputs,
      signal: controller.signal,
      sleep: async () => {}
    });

    await started;
    controller.abort(new Error('generation cancelled'));
    await expect(operation).rejects.toThrow('generation cancelled');

    expect(fetchImplementation).toHaveBeenCalledOnce();
    await expectNoTemporaryCacheFiles(paths, runtimeInputs);
  });

  it('does not start work when the operation is already aborted', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    let runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    runtimeInputs = { ...runtimeInputs, coreAssets: [] };
    const controller = new AbortController();
    controller.abort('cancelled');
    const fetchImplementation = vi.fn();

    await expect(
      copyPyodideAssets({
        fetchImplementation,
        paths,
        requestedPackages: ['dependency'],
        runtimeInputs,
        signal: controller.signal
      })
    ).rejects.toThrow('operation aborted');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('publishes one verified cache entry when concurrent writers target the same asset', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    let runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['dependency'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    runtimeInputs = { ...runtimeInputs, coreAssets: [] };
    let fetches = 0;
    let releaseWriters;
    const writersReady = new Promise((resolve) => {
      releaseWriters = resolve;
    });
    let publicationConflicts = 0;
    const fileSystem = {
      ...defaultFileSystem,
      link: async (...arguments_) => {
        try {
          await defaultFileSystem.link(...arguments_);
        } catch (error) {
          if (error?.code === 'EEXIST') publicationConflicts += 1;
          throw error;
        }
      }
    };
    const fetchPackage = async () => {
      fetches += 1;
      if (fetches === 2) releaseWriters();
      return {
        body: {
          async *[Symbol.asyncIterator]() {
            await writersReady;
            yield fixture.wheels['dependency.whl'];
          }
        }
      };
    };
    const options = {
      fetchPackage,
      fileSystem,
      paths,
      requestedPackages: ['dependency'],
      runtimeInputs
    };

    const results = await Promise.all([copyPyodideAssets(options), copyPyodideAssets(options)]);

    expect(results).toEqual([expect.any(Boolean), expect.any(Boolean)]);
    expect(results).toContain(true);
    const cachePath = path.join(
      paths.downloadCacheDir,
      'pyodide',
      fixtureVersion,
      runtimeInputs.lockSha256,
      'dependency.whl'
    );
    expect(await readFile(cachePath)).toEqual(fixture.wheels['dependency.whl']);
    expect(publicationConflicts).toBeGreaterThanOrEqual(1);
    await expectNoTemporaryCacheFiles(paths, runtimeInputs);
  });

  it('copies assets in deterministic order after out-of-order downloads', async () => {
    const fixture = await createInstalledPyodide({ packageCount: 3 });
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const packageNames = Object.keys(fixture.wheels).map((fileName) => path.basename(fileName, '.whl'));
    let runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: packageNames,
      resolvePackageJson: fixture.resolvePackageJson
    });
    runtimeInputs = { ...runtimeInputs, coreAssets: [] };
    const completed = [];
    const copied = [];
    const delays = new Map(packageNames.map((name, index) => [name, (packageNames.length - index) * 5]));
    const fileSystem = {
      ...defaultFileSystem,
      copyFile: async (sourcePath, targetPath) => {
        if (targetPath.startsWith(paths.pyodidePublicDir)) copied.push(path.basename(targetPath, '.whl'));
        return defaultFileSystem.copyFile(sourcePath, targetPath);
      }
    };
    const fetchImplementation = vi.fn(async (url) => {
      const fileName = path.basename(new URL(url).pathname);
      const packageName = path.basename(fileName, '.whl');
      return {
        body: {
          async *[Symbol.asyncIterator]() {
            await new Promise((resolve) => setTimeout(resolve, delays.get(packageName)));
            completed.push(packageName);
            yield fixture.wheels[fileName];
          }
        },
        ok: true,
        status: 200,
        statusText: 'ok'
      };
    });
    const options = { fetchImplementation, fileSystem, paths, requestedPackages: packageNames, runtimeInputs };

    await expect(copyPyodideAssets(options)).resolves.toBe(true);
    expect(completed).not.toEqual(packageNames);
    expect(copied).toEqual(packageNames);

    copied.length = 0;
    await expect(copyPyodideAssets({ ...options, fetchImplementation: vi.fn() })).resolves.toBe(false);
    expect(copied).toEqual([]);
  });

  it('rejects a hash mismatch without publishing or caching the invalid wheel', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['root'],
      resolvePackageJson: fixture.resolvePackageJson
    });

    await expect(
      copyPyodideAssets({
        fetchImplementation: async () => response(Buffer.from('invalid wheel')),
        paths,
        requestedPackages: ['root'],
        runtimeInputs,
        temporaryName: () => 'mismatch'
      })
    ).rejects.toThrow('Pyodide asset');

    const cachedWheel = path.join(
      paths.downloadCacheDir,
      'pyodide',
      fixtureVersion,
      runtimeInputs.lockSha256,
      'root.whl'
    );
    await expect(readFile(cachedWheel)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${cachedWheel}.tmp-mismatch`)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(paths.pyodidePublicDir, 'root.whl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses a new cache namespace when verified runtime inputs change', async () => {
    const fixture = await createInstalledPyodide();
    const paths = createDocRuntimePaths(fixture.workspaceRoot);
    const runtimeInputs = await resolvePyodideRuntimeInputs({
      requestedPackages: ['root'],
      resolvePackageJson: fixture.resolvePackageJson
    });
    const fetchImplementation = vi.fn(async (url) => response(fixture.wheels[path.basename(new URL(url).pathname)]));

    await copyPyodideAssets({ fetchImplementation, paths, requestedPackages: ['root'], runtimeInputs });
    await rm(paths.pyodidePublicDir, { force: true, recursive: true });
    await copyPyodideAssets({
      fetchImplementation,
      paths,
      requestedPackages: ['root'],
      runtimeInputs: { ...runtimeInputs, lockSha256: 'f'.repeat(64) }
    });

    expect(fetchImplementation).toHaveBeenCalledTimes(4);
  });

  it('bounds retries and backoff, avoids retrying permanent responses, and times out requests', async () => {
    const sleeps = [];
    const retryingFetch = vi
      .fn()
      .mockResolvedValueOnce(response(undefined, 503, 'unavailable'))
      .mockResolvedValueOnce(response(undefined, 429, 'rate limited'))
      .mockResolvedValueOnce(response(Buffer.from('wheel')));

    await expect(
      fetchPyodidePackage('root.whl', {
        fetchImplementation: retryingFetch,
        packageBaseUrl: 'https://packages.example/',
        sleep: async (milliseconds) => sleeps.push(milliseconds)
      })
    ).resolves.toEqual(Buffer.from('wheel'));
    expect(retryingFetch).toHaveBeenCalledTimes(PYODIDE_DOWNLOAD_ATTEMPTS);
    expect(sleeps).toEqual([250, 1_000]);

    const permanentFetch = vi.fn(async () => response(undefined, 404, 'not found'));
    await expect(
      fetchPyodidePackage('missing.whl', {
        fetchImplementation: permanentFetch,
        packageBaseUrl: 'https://packages.example/',
        sleep: vi.fn()
      })
    ).rejects.toThrow('after 1 attempt(s): 404 not found');
    expect(permanentFetch).toHaveBeenCalledOnce();

    await expect(
      fetchPyodidePackage('legacy-response.whl', {
        fetchImplementation: async () => ({
          arrayBuffer: async () => Buffer.from('legacy response'),
          ok: true
        }),
        packageBaseUrl: 'https://packages.example/'
      })
    ).resolves.toEqual(Buffer.from('legacy response'));

    await expect(
      fetchPyodidePackage('mixed-chunks.whl', {
        fetchImplementation: async () => ({
          body: ReadableStream.from(['mixed ', Uint8Array.from(Buffer.from('chunks')).buffer]),
          ok: true
        }),
        packageBaseUrl: 'https://packages.example/'
      })
    ).resolves.toEqual(Buffer.from('mixed chunks'));

    const hangingFetch = vi.fn(
      async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })
    );
    await expect(
      fetchPyodidePackage('slow.whl', {
        fetchImplementation: hangingFetch,
        packageBaseUrl: 'https://packages.example/',
        sleep: async () => {},
        timeoutMs: 5
      })
    ).rejects.toThrow('after 3 attempt(s): request timed out after 5ms');
    expect(hangingFetch).toHaveBeenCalledTimes(PYODIDE_DOWNLOAD_ATTEMPTS);
    expect(PYODIDE_REQUEST_TIMEOUT_MS).toBe(30_000);
  });
});

async function createInstalledPyodide({ packageCount } = {}) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-pyodide-'));
  temporaryDirectories.push(workspaceRoot);
  const packageDirectory = path.join(workspaceRoot, 'installed', 'pyodide');
  await mkdir(packageDirectory, { recursive: true });

  const wheels = packageCount
    ? Object.fromEntries(
        Array.from({ length: packageCount }, (_value, index) => [
          `package-${index}.whl`,
          Buffer.from(`package ${index} wheel`)
        ])
      )
    : {
        'dependency.whl': Buffer.from('dependency wheel'),
        'root.whl': Buffer.from('root wheel')
      };
  const lockFile = {
    info: { version: fixtureVersion },
    packages: packageCount
      ? Object.fromEntries(
          Object.entries(wheels).map(([fileName, content]) => {
            const name = path.basename(fileName, '.whl');
            return [name, packageEntry(name, fileName, content)];
          })
        )
      : {
          dependency: packageEntry('dependency', 'dependency.whl', wheels['dependency.whl']),
          root: packageEntry('root', 'root.whl', wheels['root.whl'], ['dependency'])
        }
  };
  await Promise.all([
    writeFile(path.join(packageDirectory, 'package.json'), JSON.stringify({ version: fixtureVersion })),
    ...requiredPyodideFiles.map((fileName) =>
      writeFile(
        path.join(packageDirectory, fileName),
        fileName === 'pyodide-lock.json' ? JSON.stringify(lockFile) : `core ${fileName}`
      )
    )
  ]);

  return {
    lockPath: path.join(packageDirectory, 'pyodide-lock.json'),
    resolvePackageJson: () => path.join(packageDirectory, 'package.json'),
    wheels,
    workspaceRoot
  };
}

function packageEntry(name, fileName, content, depends = []) {
  return {
    depends,
    file_name: fileName,
    name,
    sha256: hashBytes(content),
    version: 'fixture-package'
  };
}

function response(content, status = 200, statusText = 'ok') {
  return {
    body: content === undefined ? undefined : ReadableStream.from([content]),
    arrayBuffer: async () => content,
    ok: status >= 200 && status < 300,
    status,
    statusText
  };
}

function streamFailureResponse(partialContent) {
  return {
    body: {
      async *[Symbol.asyncIterator]() {
        yield partialContent;
        throw new Error('stream interrupted');
      }
    },
    ok: true,
    status: 200,
    statusText: 'ok'
  };
}

async function expectNoTemporaryCacheFiles(paths, runtimeInputs) {
  const cacheDirectory = path.join(paths.downloadCacheDir, 'pyodide', fixtureVersion, runtimeInputs.lockSha256);
  const entries = await readdir(cacheDirectory).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  expect(entries.filter((entry) => entry.includes('.tmp-') || entry.includes('.corrupt-'))).toEqual([]);
}
