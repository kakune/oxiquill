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
    Object.entries(initialFiles).map(([filePath, content]) => [filePath, Buffer.from(content)])
  );
  const copies = [];
  const writes = [];

  return {
    copies,
    existsSync: (filePath) => files.has(String(filePath)),
    files,
    mkdir: async () => undefined,
    readFile: async (filePath, encoding) => {
      const content = files.get(String(filePath));
      if (!content) {
        const error = new Error(`missing ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      return encoding ? content.toString(encoding) : Buffer.from(content);
    },
    readdir: async (directory) => {
      const prefix = `${directory}${path.sep}`;
      return Array.from(files.keys())
        .filter((filePath) => filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes(path.sep))
        .map((filePath) => path.basename(filePath))
        .sort();
    },
    copyFile: async (sourcePath, targetPath) => {
      const content = files.get(String(sourcePath));
      if (!content) {
        const error = new Error(`missing ${sourcePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      files.set(String(targetPath), Buffer.from(content));
      copies.push([String(sourcePath), String(targetPath)]);
    },
    writeFile: async (filePath, content) => {
      files.set(String(filePath), Buffer.from(content));
      writes.push(String(filePath));
    },
    writes
  };
}

const packageRoot = '/repo/node_modules/.pnpm/example@1.2.3/node_modules/example';
const packageFiles = {
  [`${packageRoot}/package.json`]: JSON.stringify({
    license: 'MIT',
    name: 'example',
    version: '1.2.3'
  }),
  [`${packageRoot}/LICENSE`]: 'Example license text'
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
    const mainModule = `${packageRoot}/main.js`;
    const workerModule = `${packageRoot}/worker.js?worker_file`;
    const collector = createBundledModuleCollector();

    expect(collectBundleModuleIds({
      asset: { fileName: 'style.css', source: '', type: 'asset' },
      chunk: { modules: { [mainModule]: {}, '\0virtual:module': {} }, type: 'chunk' }
    })).toEqual(['\0virtual:module', mainModule]);
    expect(packageRootFromModuleId(workerModule)).toBe(packageRoot);
    expect(packageRootFromModuleId('/repo/source.ts')).toBeUndefined();

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
      ['worker', [`${packageRoot}/worker.js`]],
      ['main', [packageRoot.slice(1) + '/main.js', '/repo/source.ts']]
    ]), { fileSystem, searchRoots: ['/repo/site'] });

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
    const moduleGroups = new Map([['main', [`${packageRoot}/main.js`]]]);
    const unknown = createMemoryFileSystem({
      ...packageFiles,
      [`${packageRoot}/LICENSE`]: 'Unrecognized license terms',
      [`${packageRoot}/package.json`]: JSON.stringify({ name: 'example', version: '1.2.3' })
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: unknown })).rejects.toThrow(
      'unknown license text'
    );

    const inferred = createMemoryFileSystem({
      ...packageFiles,
      [`${packageRoot}/LICENSE`]: 'Permission is hereby granted, free of charge, to any person obtaining a copy',
      [`${packageRoot}/package.json`]: JSON.stringify({ name: 'example', version: '1.2.3' })
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: inferred }))
      .resolves.toMatchObject([{ license: 'MIT' }]);

    const missingText = createMemoryFileSystem({
      [`${packageRoot}/package.json`]: packageFiles[`${packageRoot}/package.json`]
    });
    await expect(collectBundledPackageNotices(moduleGroups, { fileSystem: missingText })).rejects.toThrow(
      'license text is missing'
    );

    const overridden = createMemoryFileSystem({
      [`${packageRoot}/package.json`]: packageFiles[`${packageRoot}/package.json`],
      '/licenses/bundled-package-overrides.json': JSON.stringify({
        packages: [{ license: 'MIT', licenseFile: 'example.txt', name: 'example', version: '1.2.3' }],
        schemaVersion: 1
      }),
      '/licenses/example.txt': 'Audited fallback text'
    });
    await expect(collectBundledPackageNotices(moduleGroups, {
      fileSystem: overridden,
      licenseDataDir: '/licenses'
    })).resolves.toMatchObject([{ licenseText: '[example.txt]\nAudited fallback text' }]);
  });

  it('selects copied runtime artifacts and validates the full manifest', async () => {
    const paths = createDocRuntimePaths({ frameworkRoot: '/framework', workspaceRoot: '/repo' });
    const active = createMemoryFileSystem({
      '/licenses/MIT.txt': 'Runtime license text',
      '/repo/public/oxiquill/pyodide/runtime.wasm': 'wasm'
    });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir: '/licenses',
      manifest: runtimeManifest,
      paths
    })).resolves.toEqual([{
      license: 'MIT',
      licenseText: '[MIT.txt]\nRuntime license text',
      name: 'Runtime example',
      sources: ['copied runtime'],
      version: '4.5.6'
    }]);

    const inactive = createMemoryFileSystem({ '/licenses/MIT.txt': 'Runtime license text' });
    await expect(collectRuntimeArtifactNotices({
      fileSystem: inactive,
      licenseDataDir: '/licenses',
      manifest: runtimeManifest,
      paths
    })).resolves.toEqual([]);

    await expect(collectRuntimeArtifactNotices({
      fileSystem: createMemoryFileSystem(),
      licenseDataDir: '/licenses',
      manifest: runtimeManifest,
      paths
    })).rejects.toThrow('License text MIT.txt is missing');
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir: '/licenses',
      manifest: { artifacts: [], schemaVersion: 2 },
      paths
    })).rejects.toThrow('schemaVersion 1');
    await expect(collectRuntimeArtifactNotices({
      fileSystem: active,
      licenseDataDir: '/licenses',
      manifest: {
        artifacts: [{ ...runtimeManifest.artifacts[0], license: 'UNLICENSED' }],
        schemaVersion: 1
      },
      paths
    })).rejects.toThrow('unknown license');
  });

  it('copies own licenses and writes stable public, Cargo, and built-site reports', async () => {
    const paths = createDocRuntimePaths({ frameworkRoot: '/framework', workspaceRoot: '/repo' });
    const fileSystem = createMemoryFileSystem({
      ...packageFiles,
      '/framework/LICENSE-APACHE': 'Apache license',
      '/framework/LICENSE-MIT': 'MIT license',
      '/licenses/MIT.txt': 'Runtime license text',
      '/licenses/runtime-artifacts.json': JSON.stringify(runtimeManifest),
      '/repo/public/oxiquill/pyodide/runtime.wasm': 'wasm'
    });
    const moduleGroups = new Map([['main', [`${packageRoot}/main.js`]]]);

    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir: '/licenses',
      moduleGroups,
      paths
    })).resolves.toBe(true);
    expect(fileSystem.files.get('/repo/public/oxiquill/licenses/LICENSE-MIT').toString()).toBe('MIT license');
    expect(fileSystem.files.get('/repo/.oxiquill/rust-cells/LICENSE-APACHE').toString()).toBe('Apache license');
    expect(fileSystem.files.get('/repo/public/oxiquill/licenses/THIRD_PARTY_LICENSES.txt').toString())
      .toContain('Runtime example 4.5.6');

    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir: '/licenses',
      moduleGroups,
      paths
    })).resolves.toBe(false);
    await expect(syncLicenseArtifacts({
      fileSystem,
      licenseDataDir: '/licenses',
      moduleGroups,
      outputDirectory: '/repo/dist/oxiquill/licenses',
      paths
    })).resolves.toBe(true);
    expect(fileSystem.files.get('/repo/dist/oxiquill/licenses/THIRD_PARTY_LICENSES.txt').toString())
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
