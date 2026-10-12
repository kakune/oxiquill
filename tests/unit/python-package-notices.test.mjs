// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOxiquillIntegrationMetadata } from '../../packages/oxiquill/src/config/metadata.mjs';
import {
  resolvePythonPackageNotices,
  pythonLicensePaths
} from '../../packages/oxiquill/src/generator/doc-runtime/python-package-notices.mjs';
import { parseCellsFromMarkdown } from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';

const workspaceRoot = path.resolve('/site');
const paths = { workspaceRoot: pathToFileURL(`${workspaceRoot}${path.sep}`) };
const packageInfo = { name: 'extra', version: '1.0', file_name: 'extra.whl' };
const options = {
  additionalPackages: { extra: { version: '1.0', license: 'MIT', licenseFiles: ['legal/extra.txt'] } }
};
const normalize = (python) => createOxiquillIntegrationMetadata({ python }).python;
const fileSystem = { readFile: vi.fn(async () => 'License text') };
const resolve = (overrides = {}) =>
  resolvePythonPackageNotices({
    packages: [packageInfo],
    lockFile: { packages: { extra: packageInfo } },
    pythonOptions: normalize(options),
    fileSystem,
    paths,
    bundledManifest: { artifacts: [] },
    ...overrides
  });

describe('additional Python packages', () => {
  it('uses configured package names in authoring without allowing undeclared packages', () => {
    const source = '```python\n#| id: example\n#| packages: [extra]\nimport extra\n```';
    expect(parseCellsFromMarkdown(source, 'page.mdx').diagnostics).toHaveLength(1);
    expect(parseCellsFromMarkdown(source, 'page.mdx', normalize(options)).diagnostics).toEqual([]);
    expect(pythonLicensePaths(normalize(options), paths)).toEqual([path.join(workspaceRoot, 'legal/extra.txt')]);
  });
  it.each([
    null,
    [],
    { numpy: options.additionalPackages.extra },
    { 'bad/name': options.additionalPackages.extra },
    { extra: null },
    { extra: { ...options.additionalPackages.extra, unknown: true } },
    { extra: { ...options.additionalPackages.extra, license: 'unknown' } },
    { extra: { ...options.additionalPackages.extra, version: '' } },
    { extra: { ...options.additionalPackages.extra, licenseFiles: [] } },
    { extra: { ...options.additionalPackages.extra, licenseFiles: ['a', 'a'] } }
  ])('rejects invalid additional-package metadata: %j', (additionalPackages) => {
    expect(() => normalize({ additionalPackages })).toThrow('python.additionalPackages');
  });
  it('reads selected notices and rejects missing dependency notices', async () => {
    expect(await resolve()).toEqual([
      {
        name: 'extra',
        version: '1.0',
        license: 'MIT',
        licenseText: '[legal/extra.txt]\nLicense text',
        sources: ['copied Pyodide package']
      }
    ]);
    await expect(resolve({ packages: [{ ...packageInfo, name: 'dependency' }] })).rejects.toThrow(
      'missing a license notice'
    );
    expect(await resolve({ packages: [] })).toEqual([]);
  });
  it('accepts matching bundled notices and verifies configured versions even if unused', async () => {
    expect(
      await resolve({ bundledManifest: { artifacts: [{ version: '1.0', files: ['pyodide/extra.whl'] }] } })
    ).toEqual([]);
    await expect(resolve({ lockFile: { packages: {} }, packages: [] })).rejects.toThrow('missing from the lock');
    await expect(
      resolve({ lockFile: { packages: { extra: { ...packageInfo, version: '2.0' } } }, packages: [] })
    ).rejects.toThrow('does not match lock version');
  });
  it('rejects missing, empty, and out-of-workspace license files', async () => {
    await expect(
      resolve({
        fileSystem: {
          readFile: async () => {
            throw new Error('missing');
          }
        }
      })
    ).rejects.toThrow('Unable to read');
    await expect(resolve({ fileSystem: { readFile: async () => ' ' } })).rejects.toThrow('is empty');
    expect(() =>
      pythonLicensePaths({ additionalPackages: { extra: { licenseFiles: ['../outside'] } } }, paths)
    ).toThrow('relative to the workspace');
    expect(() => pythonLicensePaths({ additionalPackages: { extra: { licenseFiles: ['/outside'] } } }, paths)).toThrow(
      'relative to the workspace'
    );
  });
});
