import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectBundledPackageNotices,
  collectBundleModuleIds,
  collectRuntimeArtifactNotices,
  createBundledModuleCollector,
  createDocRuntimePaths,
  generateThirdPartyLicenseReport,
  packageRootFromModuleId,
  syncLicenseArtifacts
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';

function createMemoryFileSystem(initialFiles = {}) {
  const files = new Map(
    Object.entries(initialFiles).map(([filePath, content]) => [memoryPath(filePath), Buffer.from(content)])
  );
  const copies = [];
  const writes = [];

  return {
    copies,
    existsSync: (filePath) => files.has(memoryPath(filePath)),
    files,
    mkdir: async () => undefined,
    readFile: async (filePath, encoding) => {
      const content = files.get(memoryPath(filePath));
      if (!content) {
        const error = new Error(`missing ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return encoding ? content.toString(encoding) : Buffer.from(content);
    },
    readdir: async (directory) => {
      const prefix = `${memoryPath(directory)}/`;
      return Array.from(files.keys())
        .filter((filePath) => filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes('/'))
        .map((filePath) => path.posix.basename(filePath))
        .sort();
    },
    copyFile: async (sourcePath, targetPath) => {
      const normalizedSourcePath = memoryPath(sourcePath);
      const normalizedTargetPath = memoryPath(targetPath);
      const content = files.get(normalizedSourcePath);
      if (!content) {
        const error = new Error(`missing ${sourcePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.set(normalizedTargetPath, Buffer.from(content));
      copies.push([normalizedSourcePath, normalizedTargetPath]);
    },
    writeFile: async (filePath, content) => {
      const normalizedPath = memoryPath(filePath);
      files.set(normalizedPath, Buffer.from(content));
      writes.push(normalizedPath);
    },
    writes
  };
}

function memoryPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

const workspaceRoot = path.resolve('/repo');
const frameworkRoot = path.resolve('/framework');
const licenseDataDir = path.resolve('/licenses');
const packageRoot = path.join(
  workspaceRoot,
  'node_modules/.pnpm/example@1.2.3/node_modules/example'
);
const relativePackageRoot = path.relative(path.parse(packageRoot).root, packageRoot);
const workspacePath = (...segments) => path.join(workspaceRoot, ...segments);
const frameworkPath = (...segments) => path.join(frameworkRoot, ...segments);
const licensePath = (...segments) => path.join(licenseDataDir, ...segments);
const packageFiles = {
  [path.join(packageRoot, 'package.json')]: JSON.stringify({
    license: 'MIT',
    name: 'example',
    version: '1.2.3'
  }),
  [path.join(packageRoot, 'LICENSE')]: 'Example license text'
};

const runtimeManifest = {
  schemaVersion: 1,
  artifacts: [
    {
      files: ['pyodide/runtime.wasm'],
      license: 'MIT',
      licenseFiles: ['MIT.txt'],
      name: 'Runtime example',
      source: 'copied runtime',
      version: '4.5.6'
    }
  ]
};

describe('license notices', () => {
  it('discovers and groups module ids from main and worker chunks', () => {
    const mainModule = path.join(packageRoot, 'main.js');
    const workerModule = `${path.join(packageRoot, 'worker.js')}?worker_file`;
    const collector = createBundledModuleCollector();

    expect(collectBundleModuleIds({
      asset: { fileName: 'style.css', source: '', type: 'asset' },
      chunk: { modules: { [mainModule]: {}, '\0virtual:module': {} }, type: 'chunk' }
    })).toEqual(['\0virtual:module', mainModule]);
    expect(packageRootFromModuleId(workerModule)).toBe(packageRoot);
    expect(packageRootFromModuleId(workspacePath('source.ts'))).toBeUndefined();

    collector.add('worker', [workerModule, workerModule]);
    collector.add('main', [mainModule]);
    collector.add('worker', [mainModule]);
    expect(collector.snapshot()).toEqual(new Map([
      ['worker', [mainModule, workerModule]],
      ['main', [mainModule]]
    ]));
    collector.reset();
    expect(collector.snapshot()).toEqual(new Map());
  });

  it('collects deterministic bundled package notices and combines bundle sources', async () => {
    const fileSystem = createMemoryFileSystem(packageFiles);
    const notices = await collectBundledPackageNotices(new Map([
      ['worker', [path.join(packageRoot, 'worker.js')]],
      ['main', [path.join(relativePackageRoot, 'main.js'), workspacePath('source.ts')]]
    ]), { fileSystem, searchRoots: [workspacePath('site')] });

    expect(notices).toEqual([{
      license: 'MIT',
      licenseText: '[LICENSE]\nExample license text',
      name: 'example',
      sources: ['bundled JavaScript (main)', 'bundled JavaScript (worker)'],
      version: '1.2.3'
    }]);
    expect(generateThirdPartyLicenseReport(notices)).toContain('example 1.2.3');
    expect(generateThirdPartyLicenseReport(notices)).toBe(generateThirdPartyLicenseReport([...notices].reverse()));
  });

  it('fails when bundled package license metadata or text is unknown', async () => {
    const moduleGroups = new Map([['main', [path.join(packageRoot, 'main.js')]]]);
    const unknown = createMemoryFileSystem({
      ...packageFiles,
      [path.join(packageRoot, 'LICENSE')]: 'Unrecognized license terms',
      [path.join(packageRoot, 'package.json')]: JSON.stringify({ name: 'example', version: '1.2.3' })
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: unknown })).rejects.toThrow(
      'unknown license text'
    );

    const inferred = createMemoryFileSystem({
      ...packageFiles,
      [path.join(packageRoot, 'LICENSE')]: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
      [path.join(packageRoot, 'package.json')]: JSON.stringify({ name: 'example', version: '1.2.3' })
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: inferred }))
      .resolves.toMatchObject([{ license: 'MIT' }]);

    const missingText = createMemoryFileSystem({
      [path.join(packageRoot, 'package.json')]: packageFiles[path.join(packageRoot, 'package.json')]
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: missingText })).rejects.toThrow(
      'license text is missing'
    );

    const overridden = createMemoryFileSystem({
      [path.join(packageRoot, 'package.json')]: packageFiles[path.join(packageRoot, 'package.json')],
      [licensePath('bundled-package-overrides.json')]: JSON.stringify({
        packages: [{ license: 'MIT', licenseFile: 'example.txt', name: 'example', version: '1.2.3' }],
        schemaVersion: 1
      }),
      [licensePath('example.txt')]: 'Audited fallback text'
    });
    await expect(collectBundledPackageNotices(moduleGroups, {
      fileSystem: overridden,
      licenseDataDir
    })).resolves.toMatchObject([{ licenseText: '[example.txt]\nAudited fallback text' }]);
  });

  it('selects copied runtime artifacts and validates the full manifest', async () => {
    const paths = createDocRuntimePaths({ frameworkRoot, workspaceRoot });
    const active = createMemoryFileSystem({
      [licensePath('MIT.txt')]: 'Runtime license text',
      [workspacePath('public/oxiquill/pyodide/runtime.wasm')]: 'wasm'
    });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir,
      manifest: runtimeManifest,
      paths
    })).resolves.toEqual([{
      license: 'MIT',
      licenseText: '[MIT.txt]\nRuntime license text',
      name: 'Runtime example',
      sources: ['copied runtime'],
      version: '4.5.6'
    }]);

    const customPaths = createDocRuntimePaths({
      frameworkRoot,
      pyodidePublicDir: 'python-runtime',
      workspaceRoot
    });
    const custom = createMemoryFileSystem({
      [licensePath('MIT.txt')]: 'Runtime license text',
      [workspacePath('public/oxiquill/python-runtime/runtime.wasm')]: 'wasm'
    });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: custom,
      licenseDataDir,
      manifest: runtimeManifest,
      paths: customPaths
    })).resolves.toHaveLength(1);

    const inactive = createMemoryFileSystem({ [licensePath('MIT.txt')]: 'Runtime license text' });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: inactive,
      licenseDataDir,
      manifest: runtimeManifest,
      paths
    })).resolves.toEqual([]);

    const jsonText = createMemoryFileSystem({
      [licensePath('MIT.json')]: JSON.stringify({ licenseText: 'Decoded license text' }),
      [workspacePath('public/oxiquill/pyodide/runtime.wasm')]: 'wasm'
    });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: jsonText,
      licenseDataDir,
      manifest: {
        artifacts: [{ ...runtimeManifest.artifacts[0], licenseFiles: ['MIT.json'] }],
        schemaVersion: 1
      },
      paths
    })).resolves.toMatchObject([{ licenseText: '[MIT.json]\nDecoded license text' }]);

    await expect(collectRuntimeArtifactNotices({
      fileSystem: createMemoryFileSystem(),
      licenseDataDir,
      manifest: runtimeManifest,
      paths
    })).rejects.toThrow('License text MIT.txt is missing');
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir,
      manifest: { artifacts: [], schemaVersion: 2 },
      paths
    })).rejects.toThrow('schemaVersion 1');
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir,
      manifest: {
        artifacts: [{ ...runtimeManifest.artifacts[0], license: 'UNLICENSED' }],
        schemaVersion: 1
      },
      paths
    })).rejects.toThrow('unknown license');
  });

  it('copies own licenses and writes stable public, Cargo, and built-site reports', async () => {
    const paths = createDocRuntimePaths({ frameworkRoot, workspaceRoot });
    const fileSystem = createMemoryFileSystem({
      ...packageFiles,
      [frameworkPath('LICENSE-APACHE')]: 'Apache license',
      [frameworkPath('LICENSE-MIT')]: 'MIT license',
      [licensePath('MIT.txt')]: 'Runtime license text',
      [licensePath('rust/runtime-Cargo.lock')]: 'audited lock',
      [licensePath('runtime-artifacts.json')]: JSON.stringify(runtimeManifest),
      [workspacePath('public/oxiquill/pyodide/runtime.wasm')]: 'wasm'
    });
    const moduleGroups = new Map([['main', [path.join(packageRoot, 'main.js')]]]);

    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir,
      moduleGroups,
      paths
    })).resolves.toBe(true);
    expect(fileSystem.files.get(memoryPath(workspacePath('public/oxiquill/licenses/LICENSE-MIT'))).toString())
      .toBe('MIT license');
    expect(fileSystem.files.get(memoryPath(workspacePath('.oxiquill/rust-cells/LICENSE-APACHE'))).toString())
      .toBe('Apache license');
    expect(fileSystem.files.get(memoryPath(workspacePath('.oxiquill/rust-cells/Cargo.lock'))).toString())
      .toBe('audited lock');
    expect(fileSystem.files.get(memoryPath(workspacePath('public/oxiquill/licenses/THIRD_PARTY_LICENSES.txt'))).toString())
      .toContain('Runtime example 4.5.6');

    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir,
      moduleGroups,
      paths
    })).resolves.toBe(false);
    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir,
      moduleGroups,
      outputDirectory: workspacePath('dist/oxiquill/licenses'),
      paths
    })).resolves.toBe(true);
    expect(fileSystem.files.get(memoryPath(workspacePath('dist/oxiquill/licenses/THIRD_PARTY_LICENSES.txt'))).toString())
      .toContain('bundled JavaScript (main)');
  });

  it('deduplicates identical notices and rejects conflicting text', () => {
    const notice = {
      license: 'MIT',
      licenseText: 'text',
      name: 'same',
      sources: ['worker'],
      version: '1.0.0'
    };
    expect(generateThirdPartyLicenseReport([
      notice,
      { ...notice, sources: ['main'] }
    ])).toContain('Included from: main, worker');
    expect(() => generateThirdPartyLicenseReport([
      notice,
      { ...notice, licenseText: 'different' }
    ])).toThrow('Conflicting license data');
    expect(generateThirdPartyLicenseReport([])).toContain('No third-party runtime artifacts');
  });
});
