// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyPyodideAssets,
  createDocRuntimePaths,
  fetchPyodidePackage,
  hashBytes,
  PYODIDE_DOWNLOAD_ATTEMPTS,
  PYODIDE_REQUEST_TIMEOUT_MS,
  requiredPyodideFiles,
  resolvePyodideRuntimeInputs
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';

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

    await rm(paths.pyodidePublicDir, { force: true, recursive: true });
    await expect(
      copyPyodideAssets({
        ...options,
        fetchImplementation: vi.fn(),
        pythonOptions: { offline: true }
      })
    ).resolves.toBe(true);

    await writeFile(path.join(cacheDirectory, 'root.whl'), 'corrupt');
    await rm(paths.pyodidePublicDir, { force: true, recursive: true });
    await expect(
      copyPyodideAssets({
        ...options,
        fetchImplementation: vi.fn(),
        pythonOptions: { offline: true }
      })
    ).rejects.toThrow(
      `Offline Pyodide cache miss for "root.whl" at "${path.join(cacheDirectory, 'root.whl')}"; expected sha256 ${hashBytes(fixture.wheels['root.whl'])}.`
    );

    await expect(copyPyodideAssets(options)).resolves.toBe(true);
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(cacheDirectory, 'root.whl'))).toEqual(fixture.wheels['root.whl']);
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
        runtimeInputs
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
    await expect(readFile(path.join(paths.pyodidePublicDir, 'root.whl'))).rejects.toMatchObject({ code: 'ENOENT' });
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

async function createInstalledPyodide() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-pyodide-'));
  temporaryDirectories.push(workspaceRoot);
  const packageDirectory = path.join(workspaceRoot, 'installed', 'pyodide');
  await mkdir(packageDirectory, { recursive: true });

  const wheels = {
    'dependency.whl': Buffer.from('dependency wheel'),
    'root.whl': Buffer.from('root wheel')
  };
  const lockFile = {
    info: { version: fixtureVersion },
    packages: {
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
    arrayBuffer: async () => content,
    ok: status >= 200 && status < 300,
    status,
    statusText
  };
}
