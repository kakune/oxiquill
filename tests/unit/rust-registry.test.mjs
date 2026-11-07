// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createRustModuleAssets,
  validateRustModuleFiles
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-module-assets.mjs';
import {
  validateRustRegistry,
  rustModuleForCell,
  resolveRustRegistryUrls
} from '../../packages/oxiquill/src/lib/doc-runtime/rust-registry.mjs';
import {
  createRuntimeOwnedOutputs,
  validateRuntimeOwnership
} from '../../packages/oxiquill/src/generator/doc-runtime/runtime-ownership.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';

const cells = [
  { id: 'rust-a', language: 'rust' },
  { id: 'rust-b', language: 'rust' },
  { id: 'python', language: 'python' }
];
const makeAssets = (id = 'first', assigned = [cells[0]], wasm = Buffer.from('wasm')) =>
  createRustModuleAssets({
    id,
    cells: assigned,
    glue: "new URL('doc_rust_cells_bg.wasm', import.meta.url)",
    wasm,
    publicPath: 'oxiquill/rust-wasm'
  });
const first = makeAssets();
const second = makeAssets('second', [cells[1]]);
const registry = { version: 1, modules: [first.module, second.module] };

describe('versioned Rust registry', () => {
  it('routes every Rust cell exactly once and supports empty sites', () => {
    expect(() => validateRustRegistry(registry, cells)).not.toThrow();
    expect(rustModuleForCell(registry, 'rust-b')).toBe(second.module);
    expect(() => rustModuleForCell(registry, 'missing')).toThrow('missing');
    expect(() => validateRustRegistry({ version: 1, modules: [] }, [cells[2]])).not.toThrow();
    expect(() => validateRustRegistry({ version: 1, modules: [first.module] }, cells)).toThrow(
      /first.*missing cells: rust-b/
    );
  });
  it.each([undefined, [], {}, { version: 2, modules: [] }, { version: 1, modules: {} }])(
    'rejects unsupported registry metadata: %j',
    (value) => {
      expect(() => validateRustRegistry(value, cells)).toThrow('version 1');
    }
  );
  it.each(['', '../outside', 'has space', 'UPPER', 123])('rejects invalid module ids: %j', (id) => {
    expect(() =>
      validateRustRegistry({ ...registry, modules: [{ ...first.module, id }, second.module] }, cells)
    ).toThrow(/rust-a.*invalid or duplicate id/);
  });
  it('names duplicate modules, duplicate cells, non-Rust cells, and unknown cells', () => {
    expect(() => validateRustRegistry({ version: 1, modules: [first.module, first.module] }, cells)).toThrow(
      'duplicate id'
    );
    expect(() =>
      validateRustRegistry(
        { version: 1, modules: [first.module, { ...second.module, cells: ['rust-a', 'rust-b'] }] },
        cells
      )
    ).toThrow(/second.*duplicates cell rust-a.*first/);
    expect(() =>
      validateRustRegistry({ version: 1, modules: [{ ...first.module, cells: ['rust-a', 'rust-a'] }] }, [cells[0]])
    ).toThrow('duplicates cell rust-a');
    for (const id of ['python', 'missing'])
      expect(() => validateRustRegistry({ version: 1, modules: [{ ...first.module, cells: [id] }] }, cells)).toThrow(
        `non-Rust cell "${id}"`
      );
  });
  it.each([
    { fingerprint: '' },
    { cells: null },
    { glue: {} },
    { glue: { url: '../escape.js' } },
    { glue: { url: '%2fescape.js' } },
    { glue: { url: '%zz' } },
    { glue: { url: '//host/asset.js' } },
    { glue: { url: 'https://host/asset.js' } },
    { wasm: { ...first.module.wasm, integrity: 'sha256-no' } },
    { wasm: { ...first.module.wasm, bytes: -1 } }
  ])('rejects invalid module assets: %j', (changes) => {
    expect(() => validateRustRegistry({ version: 1, modules: [{ ...first.module, ...changes }] }, [cells[0]])).toThrow(
      /first.*invalid asset metadata/
    );
  });
  it.each(['/', '/nested/base/', '/nested/base'])('resolves immutable asset paths under base %s', (base) => {
    const resolved = resolveRustRegistryUrls(registry, base);
    const prefix = base === '/' ? '' : '/nested/base';
    expect(resolved.modules[0].glue.url).toBe(`${prefix}/${first.module.glue.url}`);
    expect(resolved.modules[0].wasm.url).toBe(`${prefix}/${first.module.wasm.url}`);
    expect(first.module.glue.url).not.toMatch(/^\//);
  });
});

describe('Rust module assets', () => {
  it('names final bytes deterministically and binds the glue URL to Wasm contents', () => {
    expect(makeAssets()).toEqual(first);
    const changed = makeAssets('first', [cells[0]], Buffer.from('changed'));
    expect(changed.module.glue.url).not.toBe(first.module.glue.url);
    expect(changed.module.wasm.url).not.toBe(first.module.wasm.url);
    expect(changed.module.fingerprint).not.toBe(first.module.fingerprint);
    expect(Object.values(first.files).find((value) => typeof value === 'string')).toContain(
      first.module.wasm.url.split('/').at(-1)
    );
  });
  it('validates disk assets and diagnoses missing files, integrity, and byte length', async () => {
    const options = {
      registry,
      cells,
      publicDir: '/public',
      fileSystem: { readFile: async (file) => ({ ...first.files, ...second.files })[file.split('/').at(-1)] }
    };
    await expect(validateRustModuleFiles(options)).resolves.toBeUndefined();
    for (const readFile of [
      async () => Buffer.from('corrupt'),
      async () => {
        throw new Error('ENOENT');
      }
    ]) {
      await expect(validateRustModuleFiles({ ...options, fileSystem: { readFile } })).rejects.toThrow(
        /Rust module first.*rust-a.*invalid assets/
      );
    }
  });
  it('owns only registered public files and rejects assets outside the Rust output directory', () => {
    const paths = createOxiquillPaths({ workspaceRoot: '/repo' });
    const outputs = createRuntimeOwnedOutputs(paths, registry);
    expect(
      outputs.filter((entry) => entry.language === 'rust' && entry.root === 'public').map((entry) => entry.path)
    ).toEqual(
      registry.modules.flatMap((module) =>
        [module.glue, module.wasm].map((asset) => asset.url.slice('oxiquill/'.length))
      )
    );
    const manifest = {
      schemaVersion: 1,
      manifestFingerprint: '',
      languages: {},
      ownedOutputs: outputs,
      rust: registry,
      snapshot: { cells }
    };
    expect(() => validateRuntimeOwnership(manifest, paths)).not.toThrow();
    const escaped = { ...registry, modules: [{ ...first.module, glue: { url: 'authored.js' } }, second.module] };
    expect(() => createRuntimeOwnedOutputs(paths, escaped)).toThrow('inside');
  });
});
