import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  postprocessRustWasm,
  removeUnusedWasmPackState,
  stripUnusedWasmPackState
} from '../../packages/oxiquill/src/generator/postprocess-rust-wasm.mjs';
import {
  buildHaskellWasm,
  buildRustWasm,
  collectCells,
  copyFileIfChanged,
  copyPyodideAssets,
  copyVendoredPyodidePackages,
  createHaskellBuildFingerprint,
  createRuntimeVersion,
  createDocRuntimeContext,
  createDocRuntimePaths,
  createHaskellRuntimeStatus,
  generateRuntimeVersionModule,
  HASKELL_WASM_FILE,
  hashBytes,
  hashText,
  listFiles,
  listHelperCrates,
  markRuntimeReady,
  MissingHaskellWasiCompilerError,
  readHelperManifests,
  resolveVendoredPyodidePackages,
  resolveHaskellWasiCompiler,
  shouldBuildHaskellWasm,
  shouldBuildWasm,
  stableFingerprint,
  summarizeCells,
  syncDocRuntime,
  writeIfChanged
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';
import { pathFromUrl } from '../../packages/oxiquill/src/config/paths.mjs';
import * as haskellOutputCodegen from '../../packages/oxiquill/src/generator/doc-runtime/haskell-output-codegen.mjs';

const repoRoot = path.resolve('/repo');
const repoRootMemoryPath = String(repoRoot).replaceAll('\\', '/');

function memoryPath(filePath) {
  const normalizedPath = String(filePath).replaceAll('\\', '/');
  return normalizedPath === repoRootMemoryPath || normalizedPath.startsWith(`${repoRootMemoryPath}/`)
    ? normalizedPath.replace(repoRootMemoryPath, '/repo')
    : normalizedPath;
}

function repoPath(...segments) {
  return path.join(repoRoot, ...segments);
}

function createMemoryFileSystem(initialFiles = {}) {
  const files = new Map();
  const directories = new Set([
    memoryPath(repoRoot),
    memoryPath(repoPath('src')),
    memoryPath(repoPath('src/content')),
    memoryPath(repoPath('content/docs'))
  ]);
  const writes = [];
  const copies = [];
  const removals = [];

  function ensureParents(filePath) {
    const normalizedPath = memoryPath(filePath);
    const hasDriveRoot = /^[A-Za-z]:\//u.test(normalizedPath);
    const root = hasDriveRoot ? normalizedPath.slice(0, 2) : normalizedPath.startsWith('/') ? '/' : '';
    const relativePath =
      root === '/' ? normalizedPath.slice(1) : hasDriveRoot ? normalizedPath.slice(3) : normalizedPath;
    const parts = relativePath.split('/').filter(Boolean);
    let current = root;
    if (current && current !== '/') directories.add(current);

    for (const part of parts.slice(0, -1)) {
      current = current === '/' ? `/${part}` : current ? `${current}/${part}` : part;
      directories.add(current);
    }
  }

  for (const [filePath, content] of Object.entries(initialFiles)) {
    const normalizedPath = memoryPath(filePath);
    ensureParents(normalizedPath);
    files.set(normalizedPath, Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
  }

  return {
    copies,
    existsSync: (filePath) => directories.has(memoryPath(filePath)) || files.has(memoryPath(filePath)),
    files,
    mkdir: async (directory) => {
      directories.add(memoryPath(directory));
    },
    link: async (sourcePath, targetPath) => {
      const normalizedSource = memoryPath(sourcePath);
      const normalizedTarget = memoryPath(targetPath);
      if (files.has(normalizedTarget)) {
        const error = new Error(`exists ${targetPath}`);
        error.code = 'EEXIST';
        throw error;
      }
      ensureParents(normalizedTarget);
      files.set(normalizedTarget, Buffer.from(files.get(normalizedSource)));
    },
    open: async (filePath) => {
      const normalizedPath = memoryPath(filePath);
      ensureParents(normalizedPath);
      files.set(normalizedPath, Buffer.alloc(0));
      return {
        close: async () => {},
        write: async (buffer, offset, length) => {
          const bytes = Buffer.from(buffer).subarray(offset, offset + length);
          files.set(normalizedPath, Buffer.concat([files.get(normalizedPath), bytes]));
          writes.push(normalizedPath);
          return { bytesWritten: bytes.length };
        }
      };
    },
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
      const normalizedDirectory = memoryPath(directory);
      const childNames = new Set();
      for (const filePath of files.keys()) {
        if (filePath.startsWith(`${normalizedDirectory}/`)) {
          childNames.add(filePath.slice(normalizedDirectory.length + 1).split('/')[0]);
        }
      }
      for (const candidate of directories) {
        if (candidate.startsWith(`${normalizedDirectory}/`) && candidate !== normalizedDirectory) {
          childNames.add(candidate.slice(normalizedDirectory.length + 1).split('/')[0]);
        }
      }

      return Array.from(childNames).map((name) => {
        const fullPath = `${normalizedDirectory}/${name}`;
        return {
          isDirectory: () => directories.has(fullPath),
          isFile: () => files.has(fullPath),
          name
        };
      });
    },
    rename: async (sourcePath, targetPath) => {
      const normalizedSource = memoryPath(sourcePath);
      const normalizedTarget = memoryPath(targetPath);
      ensureParents(normalizedTarget);
      for (const [filePath, content] of Array.from(files)) {
        if (filePath !== normalizedSource && !filePath.startsWith(`${normalizedSource}/`)) continue;
        files.delete(filePath);
        files.set(`${normalizedTarget}${filePath.slice(normalizedSource.length)}`, content);
      }
      for (const directory of Array.from(directories)) {
        if (directory !== normalizedSource && !directory.startsWith(`${normalizedSource}/`)) continue;
        directories.delete(directory);
        directories.add(`${normalizedTarget}${directory.slice(normalizedSource.length)}`);
      }
    },
    rm: async (filePath, options = {}) => {
      const normalizedPath = memoryPath(filePath);
      files.delete(normalizedPath);
      directories.delete(normalizedPath);
      if (options.recursive) {
        for (const candidate of Array.from(files.keys())) {
          if (candidate.startsWith(`${normalizedPath}/`)) files.delete(candidate);
        }
        for (const candidate of Array.from(directories)) {
          if (candidate.startsWith(`${normalizedPath}/`)) directories.delete(candidate);
        }
      }
      removals.push(normalizedPath);
    },
    writeFile: async (filePath, content) => {
      const normalizedPath = memoryPath(filePath);
      ensureParents(normalizedPath);
      files.set(normalizedPath, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(String(content)));
      writes.push(normalizedPath);
    },
    copyFile: async (sourcePath, targetPath) => {
      const normalizedSourcePath = memoryPath(sourcePath);
      const normalizedTargetPath = memoryPath(targetPath);
      ensureParents(normalizedTargetPath);
      files.set(normalizedTargetPath, Buffer.from(files.get(normalizedSourcePath)));
      copies.push([normalizedSourcePath, normalizedTargetPath]);
    },
    removals,
    writes
  };
}

const highlighter = {
  codeToHtml: (source, options) => Promise.resolve(`<pre data-lang="${options.lang}">${source}</pre>`)
};
const runtimeInputs = Object.freeze({
  haskell: Object.freeze({ compiler: 'wasm32-wasi-ghc', supportedVersionPrefix: '9.14.' }),
  package: Object.freeze({ repository: 'https://example.com/oxiquill', version: '0.2.0' }),
  rust: Object.freeze({
    dependencies: Object.freeze({
      console_error_panic_hook: '0.1.7',
      serde: '1.0.228',
      serde_json: '1.0.150',
      'wasm-bindgen': '0.2.122'
    }),
    edition: '2024',
    minimumVersion: '1.85.0',
    testedVersion: '1.99.0',
    target: 'wasm32-unknown-unknown',
    wasmPackMinimumVersion: '0.15.0',
    wasmPackMaximumVersionExclusive: '0.16.0'
  }),
  rustLock: 'fixture lock',
  rustLockSha256: hashText('fixture lock')
});
const runtimeSyncOptions = Object.freeze({
  generatorIdentity: async () => 'fixture-generator',
  environment: {},
  preflightToolchains: async () => ({}),
  resolvePyodideInputs: async ({ requestedPackages }) => ({
    fingerprint: stableFingerprint({ requestedPackages })
  }),
  runtimeInputs
});

function createRustRuntimeHarness(helperFiles) {
  const usesHelpers = Object.keys(helperFiles ?? {}).some((file) => file.includes('/doc-rust/'));
  const paths = createDocRuntimePaths('/repo');
  const fileSystem = createMemoryFileSystem({
    '/repo/content/docs/index.mdx': `\`\`\`rust\n//| id: rust\n//| crates: ${usesHelpers ? '[doc-rust]' : '[]'}\nprintln!("ok");\n\`\`\``,
    '/repo/crates/doc-rust/Cargo.toml': '[package]\nname = "doc-rust"\nversion = "0.1.0"\n',
    ...helperFiles
  });
  const buildRust = vi.fn(async ({ paths: runtimePaths }) => {
    await Promise.all([
      fileSystem.writeFile(path.join(runtimePaths.rustWasmPublicDir, 'doc_rust_cells.js'), 'generated js'),
      fileSystem.writeFile(path.join(runtimePaths.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'), 'generated wasm')
    ]);
  });
  const syncRustSupport = async ({ fileSystem: runtimeFileSystem, paths: runtimePaths }) => {
    await Promise.all(
      ['Cargo.lock', 'LICENSE-MIT', 'LICENSE-APACHE'].map((fileName) =>
        runtimeFileSystem.writeFile(path.join(runtimePaths.rustCellsDir, fileName), fileName)
      )
    );
  };
  const options = {
    ...runtimeSyncOptions,
    buildHaskell: vi.fn(),
    buildRust,
    fileSystem,
    helperCrates: usesHelpers ? new Map([['doc-rust', { relativePath: '../../crates/doc-rust' }]]) : new Map(),
    highlighter,
    mode: 'build',
    paths,
    syncLicenses: async () => false,
    syncPyodide: vi.fn(),
    syncRustSupport
  };

  return { buildRust, fileSystem, paths, sync: (overrides = {}) => syncDocRuntime({ ...options, ...overrides }) };
}

function pyodidePackage(name, fileName, content, depends = []) {
  return {
    depends,
    file_name: fileName,
    name,
    sha256: hashBytes(Buffer.from(content)),
    version: '1.0.0'
  };
}

describe('doc runtime service', () => {
  it('invalidates browser runtime identities when the Haskell helper changes', () => {
    const cells = [{ id: 'one', language: 'haskell', inputs: [], source: 'pure ()' }];
    const before = createRuntimeVersion(summarizeCells(cells));
    const helper = vi.spyOn(haskellOutputCodegen, 'generateHaskellOutput').mockReturnValue('-- changed helper');
    try {
      expect(createRuntimeVersion(summarizeCells(cells))).not.toBe(before);
    } finally {
      helper.mockRestore();
    }
  });
  it('postprocesses wasm-pack JavaScript without unused cached state', async () => {
    const generatedSource = [
      'let wasmModule, wasmInstance, wasm;',
      'function __wbg_finalize_init(instance, module) {',
      '    wasmInstance = instance;',
      '    wasm = instance.exports;',
      '    wasmModule = module;',
      '    cachedDataViewMemory0 = null;',
      '    return wasm;',
      '}'
    ].join('\n');

    expect(removeUnusedWasmPackState(generatedSource)).toContain('let wasm;\nfunction __wbg_finalize_init(instance) {');
    expect(removeUnusedWasmPackState(generatedSource)).not.toContain('wasmModule');
    expect(removeUnusedWasmPackState(generatedSource)).not.toContain('wasmInstance');

    const writes = [];
    const removals = [];
    const files = new Map([['/repo/pkg/doc_rust_cells.js', generatedSource]]);
    const fileSystem = {
      readFile: async (filePath) => files.get(memoryPath(filePath)),
      rm: async (filePath, options) => removals.push([memoryPath(filePath), options]),
      writeFile: async (filePath, content) => {
        const normalizedPath = memoryPath(filePath);
        files.set(normalizedPath, content);
        writes.push([normalizedPath, content]);
      }
    };

    await postprocessRustWasm({ fileSystem, rustWasmDir: '/repo/pkg' });

    expect(removals).toEqual(
      ['.gitignore', 'doc_rust_cells.d.ts', 'doc_rust_cells_bg.wasm.d.ts', 'package.json'].map((fileName) => [
        memoryPath(repoPath('pkg', fileName)),
        { force: true }
      ])
    );
    expect(writes).toHaveLength(1);
    expect(files.get('/repo/pkg/doc_rust_cells.js')).not.toContain('wasmInstance');

    writes.length = 0;
    await stripUnusedWasmPackState('/repo/pkg/doc_rust_cells.js', { fileSystem });
    expect(writes).toEqual([]);
  });

  it('creates project paths and context with discovered helper crates', async () => {
    const paths = createDocRuntimePaths('/repo');
    expect({
      docsDir: pathFromUrl(paths.docsDir),
      generatedDir: pathFromUrl(paths.generatedDir),
      haskellCellsDir: pathFromUrl(paths.haskellCellsDir),
      haskellWasmPublicDir: pathFromUrl(paths.haskellWasmPublicDir),
      licensesPublicDir: pathFromUrl(paths.licensesPublicDir),
      pyodidePublicDir: pathFromUrl(paths.pyodidePublicDir),
      rustCellsDir: pathFromUrl(paths.rustCellsDir),
      runtimeVersionPath: pathFromUrl(paths.runtimeVersionPath)
    }).toEqual({
      docsDir: repoPath('content/docs'),
      generatedDir: repoPath('.oxiquill/generated'),
      haskellCellsDir: repoPath('.oxiquill/haskell-cells'),
      haskellWasmPublicDir: repoPath('public/oxiquill/haskell-wasm'),
      licensesPublicDir: repoPath('public/oxiquill/licenses'),
      pyodidePublicDir: repoPath('public/oxiquill/pyodide'),
      rustCellsDir: repoPath('.oxiquill/rust-cells'),
      runtimeVersionPath: repoPath('.oxiquill/generated/runtime-version.ts')
    });

    const fileSystem = createMemoryFileSystem({
      '/repo/crates/doc-rust/Cargo.toml': '[package]\nname = "doc-rust"\n',
      '/repo/crates/not-a-crate/README.md': 'ignored'
    });
    const context = await createDocRuntimeContext({
      fileSystem,
      highlighter,
      readRuntimeInputs: async () => runtimeInputs,
      root: '/repo'
    });

    expect(Array.from(context.helperCrates.keys())).toEqual(['doc-rust']);
    await expect(
      createDocRuntimeContext({
        fileSystem,
        highlighter,
        readRuntimeInputs: async () => runtimeInputs,
        root: '/repo'
      })
    ).resolves.toMatchObject({
      paths: createDocRuntimePaths('/repo')
    });
  });

  it('lists helper manifests and skips missing helper crates', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/crates/b/Cargo.toml': '[package]\nname = "b-crate"\n',
      '/repo/crates/a/Cargo.toml': '[package]\nname = "a-crate"\n',
      '/repo/crates/readme.txt': 'ignored'
    });

    await expect(readHelperManifests({ fileSystem, paths })).resolves.toEqual([
      { content: '[package]\nname = "a-crate"\n', manifestPath: repoPath('crates/a/Cargo.toml') },
      { content: '[package]\nname = "b-crate"\n', manifestPath: repoPath('crates/b/Cargo.toml') }
    ]);
    const helperCrates = await listHelperCrates({ fileSystem, paths });
    expect(Array.from(helperCrates.keys())).toEqual(['a-crate', 'b-crate']);
    expect(helperCrates.get('a-crate')).toMatchObject({ name: 'a-crate' });
    await expect(listHelperCrates({ paths, readManifests: async () => [] })).resolves.toEqual(new Map());

    const missing = {
      ...fileSystem,
      readdir: async () => {
        const error = new Error('missing crates');
        error.code = 'ENOENT';
        throw error;
      }
    };
    await expect(readHelperManifests({ fileSystem: missing, paths })).resolves.toEqual([]);

    const unreadableDirectory = {
      ...fileSystem,
      readdir: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    };
    await expect(readHelperManifests({ fileSystem: unreadableDirectory, paths })).rejects.toThrow('permission denied');

    const unreadableManifest = {
      readdir: async () => [{ isDirectory: () => true, name: 'doc-rust' }],
      readFile: async () => {
        const error = new Error('broken manifest');
        error.code = 'EIO';
        throw error;
      }
    };
    await expect(readHelperManifests({ fileSystem: unreadableManifest, paths })).rejects.toThrow('broken manifest');
  });

  it('lists files recursively and collects interactive cells', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/index.mdx': 'plain',
      '/repo/content/docs/note.mdx': '```rust\n//| id: a\n//| crates: []\nprintln!("a");\n```',
      '/repo/content/docs/deep/page.md': [
        '```python',
        '#| id: b',
        'print("b")',
        '```',
        '```haskell',
        '--| id: c',
        'putStrLn "c"',
        '```'
      ].join('\n')
    });
    const paths = createDocRuntimePaths('/repo');

    await expect(listFiles(paths.docsDir, { fileSystem })).resolves.toEqual([
      repoPath('content/docs/deep/page.md'),
      repoPath('content/docs/index.mdx'),
      repoPath('content/docs/note.mdx')
    ]);

    await expect(
      collectCells({
        fileSystem,
        highlighter,
        paths,
        root: '/repo',
        helperCrates: new Map()
      })
    ).resolves.toMatchObject([{ id: 'deep__page__b' }, { id: 'deep__page__c' }, { id: 'note__a' }]);

    const oddFileSystem = {
      readdir: async () => [
        {
          isDirectory: () => false,
          isFile: () => false,
          name: 'socket'
        }
      ]
    };
    await expect(listFiles('/repo/content/docs', { fileSystem: oddFileSystem })).resolves.toEqual([]);
  });

  it('collects interactive cells from MDX pages containing math', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': [
        'Inline math: $\\text{hello world}$.',
        '',
        '$$',
        '\\frac{x + 1}{y}',
        '$$',
        '',
        '```python',
        '#| id: example',
        'print("ok")',
        '```'
      ].join('\n')
    });

    await expect(
      collectCells({
        fileSystem,
        helperCrates: new Map(),
        highlighter,
        paths: createDocRuntimePaths('/repo'),
        root: '/repo'
      })
    ).resolves.toMatchObject([
      {
        id: 'page__example',
        language: 'python',
        pagePath: 'content/docs/page.mdx',
        source: 'print("ok")'
      }
    ]);
  });

  it('fails clearly when an MDX Rust cell references an unknown helper crate', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': '```rust\n//| id: a\n//| crates: [missing-helper]\nprintln!("a");\n```'
    });

    await expect(
      collectCells({
        fileSystem,
        helperCrates: new Map(),
        highlighter,
        paths: createDocRuntimePaths('/repo'),
        root: '/repo'
      })
    ).rejects.toThrow('content/docs/page.mdx:1 [cell "a"] crates[0]: Unknown Rust helper crate "missing-helper"');
  });

  it('fails clearly when an MDX Python cell specifies unsupported packages', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': '```python\n#| id: py\n#| packages: [scipy]\nprint("py")\n```'
    });

    await expect(
      collectCells({
        fileSystem,
        helperCrates: new Map(),
        highlighter,
        paths: createDocRuntimePaths('/repo'),
        root: '/repo'
      })
    ).rejects.toThrow('content/docs/page.mdx:1 [cell "py"] packages[0]: Unsupported Pyodide package "scipy"');
  });

  it('fails clearly when an MDX Haskell cell uses unsupported dependency metadata', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': '```haskell\n--| id: hs\n--| packages: [lens]\nputStrLn "hs"\n```'
    });

    await expect(
      collectCells({
        fileSystem,
        helperCrates: new Map(),
        highlighter,
        paths: createDocRuntimePaths('/repo'),
        root: '/repo'
      })
    ).rejects.toThrow('content/docs/page.mdx:1 [cell "hs"] packages: This field is not supported for Haskell cells');
  });

  it('rejects local and scoped cell id duplicates before highlighting or writing output', async () => {
    const localDuplicate = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': [
        '```rust',
        '//| id: repeated',
        '//| crates: []',
        'println!("one");',
        '```',
        '```rust',
        '//| id: repeated',
        '//| crates: []',
        'println!("two");',
        '```'
      ].join('\n')
    });
    let highlights = 0;
    const countingHighlighter = {
      codeToHtml: async () => {
        highlights += 1;
        return '<pre></pre>';
      }
    };

    await expect(
      syncDocRuntime({
        ...runtimeSyncOptions,
        fileSystem: localDuplicate,
        helperCrates: new Map(),
        highlighter: countingHighlighter,
        paths: createDocRuntimePaths('/repo')
      })
    ).rejects.toThrow('content/docs/page.mdx:6 [cell "repeated"] id: Duplicate page-local cell id "repeated"');
    expect(highlights).toBe(0);
    expect(localDuplicate.writes).toEqual([]);

    const scopedDuplicate = createMemoryFileSystem({
      '/repo/content/docs/a-b.mdx': '```python\n#| id: repeated\nprint("one")\n```',
      '/repo/content/docs/a.b.mdx': '```python\n#| id: repeated\nprint("two")\n```'
    });
    await expect(
      syncDocRuntime({
        ...runtimeSyncOptions,
        fileSystem: scopedDuplicate,
        helperCrates: new Map(),
        highlighter: countingHighlighter,
        paths: createDocRuntimePaths('/repo')
      })
    ).rejects.toThrow('content/docs/a.b.mdx:1 [cell "repeated"] id: Scoped cell id "a-b__repeated" collides');
    expect(highlights).toBe(0);
    expect(scopedDuplicate.writes).toEqual([]);
  });

  it('writes and copies only when content changes', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/source.bin': Buffer.from([1, 2, 3]),
      '/repo/target.bin': Buffer.from([1, 2, 3]),
      '/repo/text.txt': 'same'
    });

    await expect(writeIfChanged('/repo/text.txt', 'same', { fileSystem })).resolves.toBe(false);
    await expect(writeIfChanged('/repo/text.txt', 'next', { fileSystem })).resolves.toBe(true);
    await expect(writeIfChanged('/repo/missing.txt', 'new', { fileSystem })).resolves.toBe(true);

    await expect(copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem })).resolves.toBe(false);
    fileSystem.files.set('/repo/source.bin', Buffer.from([4, 5, 6]));
    await expect(copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem })).resolves.toBe(true);
    await expect(copyFileIfChanged('/repo/source.bin', '/repo/new-target.bin', { fileSystem })).resolves.toBe(true);

    const failingText = {
      ...fileSystem,
      readFile: async () => {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
    };
    await expect(writeIfChanged('/repo/text.txt', 'next', { fileSystem: failingText })).rejects.toThrow(
      'permission denied'
    );

    const failingBinary = {
      ...fileSystem,
      readFile: async () => {
        const error = new Error('broken read');
        error.code = 'EIO';
        throw error;
      }
    };
    await expect(
      copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem: failingBinary })
    ).rejects.toThrow('broken read');
  });

  it('serializes concurrent copies to the same target', async () => {
    const fileSystem = createMemoryFileSystem({ '/repo/source.bin': Buffer.from([1, 2, 3]) });
    let activeCopy = false;
    let copies = 0;
    const lockingFileSystem = {
      ...fileSystem,
      copyFile: async (...arguments_) => {
        copies += 1;
        if (activeCopy) {
          const error = new Error('resource busy');
          error.code = 'EBUSY';
          throw error;
        }
        activeCopy = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          await fileSystem.copyFile(...arguments_);
        } finally {
          activeCopy = false;
        }
      }
    };

    await expect(
      Promise.all([
        copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem: lockingFileSystem }),
        copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem: lockingFileSystem })
      ])
    ).resolves.toEqual([true, false]);
    expect(copies).toBe(1);
  });

  it('copies Pyodide assets from a package-graph resolution', async () => {
    const paths = createDocRuntimePaths('/repo');
    const lockFile = {
      packages: {
        matplotlib: pyodidePackage('matplotlib', 'matplotlib.whl', 'matplotlib bytes'),
        pandas: pyodidePackage('pandas', 'pandas.whl', 'pandas bytes')
      }
    };
    const packageDir = '/repo/node_modules/.pnpm/pyodide@0.29.4/node_modules/pyodide';
    const present = createMemoryFileSystem(
      Object.fromEntries(
        [
          ['package.json', JSON.stringify({ version: '314.0.6' })],
          'pyodide.mjs',
          'pyodide.mjs.map',
          'pyodide.asm.mjs',
          'pyodide.asm.wasm',
          'python_stdlib.zip',
          ['pyodide-lock.json', JSON.stringify(lockFile)]
        ].map((file) => (Array.isArray(file) ? [`${packageDir}/${file[0]}`, file[1]] : [`${packageDir}/${file}`, file]))
      )
    );
    const fetched = {
      'matplotlib.whl': Buffer.from('matplotlib bytes'),
      'pandas.whl': Buffer.from('pandas bytes')
    };
    const fetchPackage = async (fileName) => fetched[fileName];

    const resolvePackageJson = () => `${packageDir}/package.json`;
    await expect(copyPyodideAssets({ fetchPackage, fileSystem: present, paths, resolvePackageJson })).resolves.toBe(
      true
    );
    expect(present.files.get('/repo/public/oxiquill/pyodide/matplotlib.whl')).toEqual(Buffer.from('matplotlib bytes'));
    expect(present.files.get('/repo/public/oxiquill/pyodide/pandas.whl')).toEqual(Buffer.from('pandas bytes'));
    await expect(copyPyodideAssets({ fetchPackage, fileSystem: present, paths, resolvePackageJson })).resolves.toBe(
      false
    );
  });

  it('fails clearly when Pyodide or a required source asset is missing', async () => {
    const paths = createDocRuntimePaths('/repo');
    await expect(
      copyPyodideAssets({
        fileSystem: createMemoryFileSystem(),
        paths,
        resolvePackageJson: () => {
          throw new Error('MODULE_NOT_FOUND');
        }
      })
    ).rejects.toThrow('Unable to resolve required Pyodide package "pyodide" from Oxiquill');

    const packageDir = '/repo/installed/pyodide';
    const missingWasm = createMemoryFileSystem(
      Object.fromEntries(
        [
          'pyodide.mjs',
          'pyodide.mjs.map',
          'pyodide.asm.mjs',
          'python_stdlib.zip',
          ['pyodide-lock.json', JSON.stringify({ packages: {} })]
        ].map((file) => (Array.isArray(file) ? [`${packageDir}/${file[0]}`, file[1]] : [`${packageDir}/${file}`, file]))
      )
    );

    await expect(
      copyPyodideAssets({
        fileSystem: missingWasm,
        paths,
        resolvePackageJson: () => `${packageDir}/package.json`
      })
    ).rejects.toThrow(
      `Required Pyodide asset "pyodide.asm.wasm" is missing from package "pyodide" at "${path.join(packageDir, 'pyodide.asm.wasm')}"`
    );
  });

  it('resolves and verifies vendored Pyodide packages recursively', async () => {
    const paths = createDocRuntimePaths('/repo');
    const lockFile = {
      packages: {
        root: pyodidePackage('root', 'root.whl', 'root bytes', ['dep', 'dep', 'leaf']),
        dep: pyodidePackage('dep', 'dep.whl', 'dep bytes'),
        leaf: {
          file_name: 'leaf.whl',
          name: 'leaf',
          sha256: hashBytes(Buffer.from('leaf bytes')),
          version: '1.0.0'
        }
      }
    };
    const fileSystem = createMemoryFileSystem();
    const fetched = {
      'dep.whl': Buffer.from('dep bytes'),
      'leaf.whl': Buffer.from('leaf bytes'),
      'root.whl': Buffer.from('root bytes')
    };

    expect(resolveVendoredPyodidePackages(lockFile, ['root']).map((entry) => entry.name)).toEqual([
      'dep',
      'leaf',
      'root'
    ]);
    await expect(
      copyVendoredPyodidePackages({
        fetchPackage: async (fileName) => fetched[fileName],
        fileSystem,
        lockFile,
        paths,
        pyodideVersion: '314.0.6',
        roots: ['root']
      })
    ).resolves.toBe(true);
    await expect(
      copyVendoredPyodidePackages({
        fetchPackage: async (fileName) => fetched[fileName],
        fileSystem,
        lockFile,
        paths,
        pyodideVersion: '314.0.6',
        roots: ['root']
      })
    ).resolves.toBe(false);

    expect(() => resolveVendoredPyodidePackages({}, ['root'])).toThrow('missing a packages table');
    expect(() => resolveVendoredPyodidePackages({ packages: {} }, ['missing'])).toThrow(
      'Pyodide package "missing" is missing'
    );
    await expect(
      copyVendoredPyodidePackages({
        fetchPackage: async () => Buffer.from('changed'),
        fileSystem: createMemoryFileSystem(),
        lockFile,
        paths,
        pyodideVersion: '314.0.6',
        roots: ['root']
      })
    ).rejects.toThrow('has sha256');

    const readFailure = createMemoryFileSystem();
    const originalReadFile = readFailure.readFile;
    readFailure.readFile = async (filePath) => {
      if (filePath.endsWith('.whl')) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return originalReadFile(filePath);
    };
    await expect(
      copyVendoredPyodidePackages({
        fetchPackage: async (fileName) => fetched[fileName],
        fileSystem: readFailure,
        lockFile,
        paths,
        pyodideVersion: '314.0.6',
        roots: ['root']
      })
    ).rejects.toThrow('permission denied');
  });

  it('downloads vendored Pyodide packages with the default fetcher', async () => {
    const paths = createDocRuntimePaths('/repo');
    const lockFile = {
      packages: {
        root: pyodidePackage('root', 'root.whl', 'root bytes')
      }
    };
    const originalFetch = globalThis.fetch;
    const requestedUrls = [];

    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return {
        body: ReadableStream.from([Buffer.from('root bytes')]),
        ok: true,
        arrayBuffer: async () => Buffer.from('root bytes')
      };
    };
    try {
      await expect(
        copyVendoredPyodidePackages({
          fileSystem: createMemoryFileSystem(),
          lockFile,
          paths,
          pyodideVersion: '314.0.6',
          roots: ['root']
        })
      ).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestedUrls).toEqual(['https://cdn.jsdelivr.net/pyodide/v314.0.6/full/root.whl']);

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      statusText: 'unavailable'
    });
    try {
      await expect(
        copyVendoredPyodidePackages({
          fileSystem: createMemoryFileSystem(),
          lockFile,
          paths,
          pyodideVersion: '314.0.6',
          roots: ['root']
        })
      ).rejects.toThrow('503 unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('syncs generated runtime files and reports changed surfaces', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': [
        '```rust',
        '//| id: a',
        '//| crates: [doc-rust]',
        'println!("a");',
        '```',
        '```haskell',
        '--| id: h',
        'putStrLn "h"',
        '```'
      ].join('\n')
    });
    await fileSystem.writeFile('/repo/crates/doc-rust/Cargo.toml', '[package]\nname = "doc-rust"\nversion = "0.1.0"\n');
    const helperCrates = await listHelperCrates({ fileSystem, paths, root: '/repo' });
    const syncRustSupport = async ({ fileSystem: runtimeFileSystem, paths: runtimePaths }) => {
      await Promise.all(
        ['Cargo.lock', 'LICENSE-MIT', 'LICENSE-APACHE'].map((fileName) =>
          runtimeFileSystem.writeFile(path.join(runtimePaths.rustCellsDir, fileName), fileName)
        )
      );
    };

    const first = await syncDocRuntime({
      ...runtimeSyncOptions,
      fileSystem,
      helperCrates,
      highlighter,
      paths,
      root: '/repo',
      syncLicenses: async () => false,
      syncPyodide: async () => false,
      syncRustSupport
    });

    expect(first).toMatchObject({
      cellCount: 2,
      cellsChanged: true,
      haskellCellCount: 1,
      haskellChanged: true,
      pyodideChanged: false,
      rustCellCount: 1,
      rustChanged: true
    });
    expect(Array.from(fileSystem.files.keys())).toEqual(
      expect.arrayContaining([
        '/repo/.oxiquill/generated/cells.ts',
        '/repo/.oxiquill/generated/cells.json',
        '/repo/.oxiquill/generated/runtime-ownership.json',
        '/repo/.oxiquill/rust-cells/Cargo.toml',
        '/repo/.oxiquill/rust-cells/src/lib.rs',
        '/repo/.oxiquill/haskell-cells/Main.hs'
      ])
    );

    await expect(markRuntimeReady({ fileSystem, paths, summary: first, version: 'ready-1' })).resolves.toBe(true);
    expect(fileSystem.files.get('/repo/.oxiquill/generated/runtime-version.ts').toString()).toContain('ready-1');
    expect(generateRuntimeVersionModule('ready-2')).toContain('ready-2');
    expect(hashText('runtime')).toHaveLength(64);

    const runtimeVersion = JSON.parse(
      createRuntimeVersion({
        manifestFingerprint: 'manifest',
        rustFingerprint: 'rust'
      })
    );
    expect(runtimeVersion.manifest).toBe(hashText('manifest'));
    expect(runtimeVersion.haskell).toBe(hashText(''));
    expect(runtimeVersion.rust).toBe(hashText('rust'));
    expect(runtimeVersion.python).toEqual([]);
    expect(JSON.parse(createRuntimeVersion({ pythonPackages: ['matplotlib', 'pandas'] })).python).toEqual([
      'matplotlib',
      'pandas'
    ]);

    const emptyRuntimeVersion = JSON.parse(createRuntimeVersion());
    expect(emptyRuntimeVersion.manifest).toBe(hashText(''));
    expect(emptyRuntimeVersion.rust).toBe(hashText(''));

    fileSystem.writes.length = 0;
    await expect(
      syncDocRuntime({
        ...runtimeSyncOptions,
        fileSystem,
        helperCrates,
        highlighter,
        paths,
        root: '/repo',
        syncLicenses: async () => false,
        syncPyodide: async () => false,
        syncRustSupport
      })
    ).resolves.toMatchObject({
      cellsChanged: false,
      rustChanged: false
    });
    expect(fileSystem.writes).toEqual([]);
  });

  it('rebuilds Rust when authored text and extensionless helper inputs change', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness({
      '/repo/crates/Cargo.lock': '# lock one',
      '/repo/crates/doc-rust/build.rs': 'fn main() {}',
      '/repo/crates/doc-rust/help': 'help one'
    });

    await sync();
    expect(buildRust).toHaveBeenCalledTimes(1);
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'keep' } } } });

    await fileSystem.writeFile('/repo/crates/doc-rust/help', 'help two');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });

    await fileSystem.writeFile('/repo/crates/doc-rust/template.html', '<p>template</p>');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });

    await fileSystem.rm('/repo/crates/doc-rust/help');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });

    await fileSystem.writeFile('/repo/crates/Cargo.lock', '# lock two');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'keep' } } } });

    await fileSystem.writeFile('/repo/crates/doc-rust/build.rs', 'fn main() { println!("changed"); }');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });
    expect(buildRust).toHaveBeenCalledTimes(5);
  });

  it('rebuilds between accepted toolchains and retains full compiler details', async () => {
    const { buildRust, fileSystem, paths, sync } = createRustRuntimeHarness();
    const toolchain = (version) => ({
      rust: {
        rustc: `rustc ${version} (hash date)`,
        cargo: `cargo ${version} (hash date)`,
        'wasm-pack': 'wasm-pack 0.15.1',
        target: 'wasm32-unknown-unknown'
      }
    });
    await sync({ preflightToolchains: async () => toolchain('1.85.0') });
    const first = JSON.parse(await fileSystem.readFile(path.join(paths.generatedDir, 'runtime-ownership.json'), 'utf8'))
      .languages.rust.buildFingerprint;
    await sync({ preflightToolchains: async () => toolchain('1.100.0') });
    const second = JSON.parse(
      await fileSystem.readFile(path.join(paths.generatedDir, 'runtime-ownership.json'), 'utf8')
    ).languages.rust.buildFingerprint;
    expect(second).not.toBe(first);
    expect(second).toContain('rustc 1.100.0 (hash date)');
    await sync({ preflightToolchains: async () => toolchain('1.100.0') });
    expect(buildRust).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when PATH optimizers appear, disappear, or change and reuses release output for dev', async () => {
    const { buildRust, sync } = createRustRuntimeHarness();
    for (const wasmOpt of [
      { identity: 'managed-by-wasm-pack' },
      { command: '/tools/wasm-opt', identity: { version: '117', sha256: 'first' } },
      { command: '/tools/wasm-opt', identity: { version: '117', sha256: 'second' } },
      { command: '/tools/wasm-opt', identity: { version: '118', sha256: 'second' } },
      { identity: 'managed-by-wasm-pack' }
    ]) {
      const before = buildRust.mock.calls.length;
      const preflightToolchains = async () => ({ rust: { wasmOpt } });
      await sync({ preflightToolchains });
      expect(buildRust).toHaveBeenCalledTimes(before + 1);
      await sync({ preflightToolchains, mode: 'dev' });
      expect(buildRust).toHaveBeenCalledTimes(before + 1);
      expect(buildRust.mock.calls.at(-1)[0].wasmOpt).toEqual(wasmOpt);
    }
  });

  it('invalidates Rust builds for generator, environment, Cargo config, and each reported tool version', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness();
    await sync();
    await sync({ environment: { UNRELATED: 'ignored' } });
    expect(buildRust).toHaveBeenCalledOnce();
    for (const overrides of [
      { generatorIdentity: async () => 'updated generator' },
      { environment: { RUSTFLAGS: '-C opt-level=1' } },
      { environment: { BINARYEN_CORES: '2' } },
      ...['rustc', 'cargo', 'wasm-pack', 'wasmOpt'].map((name) => ({
        preflightToolchains: async () => ({ rust: { [name]: 'changed' } })
      }))
    ]) {
      const count = buildRust.mock.calls.length;
      await sync(overrides);
      expect(buildRust).toHaveBeenCalledTimes(count + 1);
      await sync(overrides);
      expect(buildRust).toHaveBeenCalledTimes(count + 1);
    }
    await sync();
    const count = buildRust.mock.calls.length;
    await fileSystem.writeFile('/repo/.cargo/config.toml', '[build]\njobs = 2');
    await sync();
    expect(buildRust).toHaveBeenCalledTimes(count + 1);
  });

  it('rebuilds modified published files and upgrades legacy manifests without integrity records', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness();
    await sync();
    for (const content of ['truncated', 'modified wasm!']) {
      const count = buildRust.mock.calls.length;
      const manifest = JSON.parse(await fileSystem.readFile('/repo/.oxiquill/generated/cells.json', 'utf8'));
      await fileSystem.writeFile(path.join('/repo/public', manifest.rust.modules[0].wasm.url), content);
      await sync();
      expect(buildRust).toHaveBeenCalledTimes(count + 1);
    }
    const ownershipPath = '/repo/.oxiquill/generated/runtime-ownership.json';
    const ownership = JSON.parse(fileSystem.files.get(ownershipPath).toString());
    delete ownership.languages.rust.publicFileIntegrity;
    await fileSystem.writeFile(ownershipPath, JSON.stringify(ownership));
    await sync();
    expect(buildRust).toHaveBeenCalledTimes(4);
    await sync();
    expect(buildRust).toHaveBeenCalledTimes(4);
  });

  it('reuses production artifacts for dev and records the actual mode after a changed dev build', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness();
    await sync();
    await sync({ mode: 'dev' });
    expect(buildRust).toHaveBeenCalledOnce();
    await fileSystem.writeFile('/repo/content/docs/index.mdx', '```rust\n//| id: rust\nprintln!("changed");\n```');
    await sync({ mode: 'dev' });
    const state = JSON.parse(fileSystem.files.get('/repo/.oxiquill/generated/runtime-ownership.json').toString());
    expect(state.languages.rust.mode).toBe('dev');
    expect(JSON.parse(state.languages.rust.buildFingerprint).mode).toBe('dev');
    await sync();
    expect(buildRust).toHaveBeenCalledTimes(3);
  });

  it('invalidates Haskell output for generator identity, compiler version, mode and corruption', async () => {
    const { fileSystem, sync } = createRustRuntimeHarness();
    await fileSystem.writeFile('/repo/content/docs/index.mdx', '```haskell\n--| id: hs\nputStrLn "hi"\n```');
    const buildHaskell = vi.fn(async ({ paths }) => {
      await fileSystem.writeFile(path.join(paths.haskellWasmPublicDir, 'doc_haskell_cells.wasm'), 'haskell wasm');
      return { ok: true };
    });
    const options = {
      buildHaskell,
      mode: 'dev',
      preflightToolchains: async () => ({ haskell: { version: '9.14.1' } })
    };
    await sync(options);
    await sync(options);
    expect(buildHaskell).toHaveBeenCalledOnce();
    await sync({ ...options, generatorIdentity: async () => 'changed generator' });
    expect(buildHaskell).toHaveBeenCalledTimes(2);
    const updated = { ...options, preflightToolchains: async () => ({ haskell: { version: '9.14.2' } }) };
    await sync(updated);
    expect(buildHaskell).toHaveBeenCalledTimes(3);
    await sync({ ...updated, mode: 'build' });
    expect(buildHaskell).toHaveBeenCalledTimes(4);
    await fileSystem.writeFile('/repo/public/oxiquill/haskell-wasm/doc_haskell_cells.wasm', 'edited wasm!');
    await sync({ ...updated, mode: 'build' });
    expect(buildHaskell).toHaveBeenCalledTimes(5);
  });

  it('regenerates a cached Rust runtime with an obsolete output contract', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness();
    await sync();
    const ownershipPath = '/repo/.oxiquill/generated/runtime-ownership.json';
    const ownership = JSON.parse(fileSystem.files.get(ownershipPath).toString());
    ownership.languages.rust.sourceFingerprint = 'obsolete-output-contract';
    ownership.languages.rust.buildFingerprint = 'obsolete-output-contract';
    await fileSystem.writeFile(ownershipPath, JSON.stringify(ownership));
    await fileSystem.writeFile('/repo/.oxiquill/rust-cells/src/lib.rs', 'struct CellOutput { stdout: String }');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });
    expect(buildRust).toHaveBeenCalledTimes(2);
    const source = fileSystem.files.get('/repo/.oxiquill/rust-cells/src/lib.rs').toString();
    expect(source).toContain('outputs: Vec<OutputArtifact>');
    expect(source).not.toContain('stdout: String');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'keep' } } } });
  });

  it('fingerprints binary helper inputs byte-for-byte', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness({
      '/repo/crates/doc-rust/logo.bin': Buffer.from([0x80])
    });

    await sync();
    await fileSystem.writeFile('/repo/crates/doc-rust/logo.bin', Buffer.from([0x81]));
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });
    expect(buildRust).toHaveBeenCalledTimes(2);
  });

  it('keeps helper fingerprints stable across directory entry order', async () => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness({
      '/repo/crates/doc-rust/alpha.txt': 'alpha',
      '/repo/crates/doc-rust/nested/beta.bin': Buffer.from([0, 1, 2])
    });
    const readdir = fileSystem.readdir;
    let reverseHelperEntries = false;
    fileSystem.readdir = async (directory, options) => {
      const entries = await readdir(directory, options);
      return reverseHelperEntries && memoryPath(directory).startsWith('/repo/crates') ? entries.reverse() : entries;
    };

    await sync();
    reverseHelperEntries = true;
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'keep' } } } });
    expect(buildRust).toHaveBeenCalledOnce();
  });

  it('ignores Cargo output and nested VCS metadata in helper fingerprints', async () => {
    const ignoredFiles = {
      '/repo/crates/doc-rust/target/debug/generated.rs': 'generated one',
      '/repo/crates/doc-rust/target/debug/build.toml': 'generated one',
      '/repo/crates/doc-rust/target/debug/logo.bin': Buffer.from([1]),
      '/repo/crates/doc-rust/nested/.git/config': 'git one',
      '/repo/crates/doc-rust/nested/.hg/store': 'hg one',
      '/repo/crates/doc-rust/nested/.svn/entries': 'svn one'
    };
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness({
      '/repo/crates/doc-rust/src/lib.rs': 'pub fn helper() {}',
      ...ignoredFiles
    });

    await sync();
    for (const [filePath, content] of Object.entries(ignoredFiles)) {
      const changed = Buffer.isBuffer(content) ? Buffer.from([2]) : `${content} changed`;
      await fileSystem.writeFile(filePath, changed);
    }
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'keep' } } } });
    expect(buildRust).toHaveBeenCalledOnce();

    await fileSystem.writeFile('/repo/crates/doc-rust/src/lib.rs', 'pub fn helper() { println!("changed"); }');
    await expect(sync()).resolves.toMatchObject({ plan: { languages: { rust: { public: 'build' } } } });
    expect(buildRust).toHaveBeenCalledTimes(2);
  });

  it('keeps a zero-cell project free of language runtimes and tool invocations', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/index.mdx': '# Static documentation'
    });
    const buildRust = vi.fn();
    const buildHaskell = vi.fn();
    const syncPyodide = vi.fn();

    const result = await syncDocRuntime({
      ...runtimeSyncOptions,
      buildHaskell,
      buildRust,
      fileSystem,
      helperCrates: new Map(),
      highlighter,
      mode: 'build',
      paths,
      syncLicenses: async () => false,
      syncPyodide
    });

    expect(result).toMatchObject({ cellCount: 0, haskellCellCount: 0, pythonCellCount: 0, rustCellCount: 0 });
    expect(buildRust).not.toHaveBeenCalled();
    expect(buildHaskell).not.toHaveBeenCalled();
    expect(syncPyodide).not.toHaveBeenCalled();
    expect(fileSystem.existsSync('/repo/.oxiquill/rust-cells')).toBe(false);
    expect(fileSystem.existsSync('/repo/public/oxiquill/pyodide')).toBe(false);
    expect(fileSystem.existsSync('/repo/.oxiquill/haskell-cells')).toBe(false);
    expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(true);
  });

  it('copies only Python assets, skips an unchanged rerun, and removes stale Python output safely', async () => {
    const paths = createDocRuntimePaths({ frameworkRoot: '/repo/framework', workspaceRoot: '/repo' });
    const fileSystem = createMemoryFileSystem({
      '/repo/framework/package.json': '{"dependencies":{"pyodide":"314.0.6"}}',
      '/repo/content/docs/index.mdx': '```python\n#| id: py\nprint("python")\n```',
      '/repo/public/oxiquill/licenses/keep.txt': 'notice'
    });
    const buildRust = vi.fn();
    const buildHaskell = vi.fn();
    const syncPyodide = vi.fn(async ({ fileSystem: runtimeFileSystem, paths: runtimePaths }) => {
      await runtimeFileSystem.writeFile(path.join(runtimePaths.pyodidePublicDir, 'pyodide.mjs'), 'python');
    });
    const options = {
      ...runtimeSyncOptions,
      buildHaskell,
      buildRust,
      fileSystem,
      helperCrates: new Map(),
      highlighter,
      mode: 'build',
      paths,
      syncLicenses: async () => false,
      syncPyodide
    };

    await syncDocRuntime(options);
    expect(syncPyodide).toHaveBeenCalledOnce();
    expect(buildRust).not.toHaveBeenCalled();
    expect(buildHaskell).not.toHaveBeenCalled();

    fileSystem.writes.length = 0;
    await syncDocRuntime(options);
    expect(syncPyodide).toHaveBeenCalledOnce();
    expect(fileSystem.writes).toEqual([]);

    await fileSystem.writeFile('/repo/content/docs/index.mdx', '# Python removed');
    await syncDocRuntime(options);
    expect(fileSystem.existsSync('/repo/public/oxiquill/pyodide')).toBe(false);
    expect(fileSystem.existsSync('/repo/public/oxiquill/licenses/keep.txt')).toBe(true);
  });

  it('builds Rust once for unchanged inputs and preserves old output and readiness on failure', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/index.mdx': '```rust\n//| id: rust\n//| crates: []\nprintln!("one");\n```'
    });
    const syncRustSupport = async ({ fileSystem: runtimeFileSystem, paths: runtimePaths }) => {
      await Promise.all(
        ['Cargo.lock', 'LICENSE-MIT', 'LICENSE-APACHE'].map((fileName) =>
          runtimeFileSystem.writeFile(path.join(runtimePaths.rustCellsDir, fileName), fileName)
        )
      );
    };
    const buildRust = vi.fn(async ({ paths: runtimePaths }) => {
      await Promise.all([
        fileSystem.writeFile(path.join(runtimePaths.rustWasmPublicDir, 'doc_rust_cells.js'), 'old js'),
        fileSystem.writeFile(path.join(runtimePaths.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'), 'old wasm')
      ]);
    });
    const options = {
      ...runtimeSyncOptions,
      buildHaskell: vi.fn(),
      buildRust,
      fileSystem,
      helperCrates: new Map(),
      highlighter,
      mode: 'build',
      paths,
      syncLicenses: async () => false,
      syncPyodide: vi.fn(),
      syncRustSupport
    };

    await syncDocRuntime(options);
    await syncDocRuntime(options);
    expect(buildRust).toHaveBeenCalledOnce();

    await fileSystem.writeFile(
      '/repo/content/docs/index.mdx',
      '```rust\n//| id: rust\n//| crates: []\nprintln!("two");\n```'
    );
    const runtimeFileSystem = {
      ...fileSystem,
      readdir: async (...args) => (await fileSystem.readdir(...args)).map((entry) => entry.name)
    };
    buildRust.mockImplementationOnce(async (buildOptions) =>
      buildRustWasm({
        ...buildOptions,
        fileSystem: runtimeFileSystem,
        wasmOpt: { command: '/tools/wasm-opt', identity: { version: '117', sha256: 'binary' } },
        runCommand: async (command) => {
          if (command === 'wasm-pack') {
            await fileSystem.writeFile(
              path.join(buildOptions.paths.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'),
              'new unoptimized wasm'
            );
          } else {
            throw new Error('wasm-opt failed');
          }
        }
      })
    );

    await expect(syncDocRuntime(options)).rejects.toThrow('/tools/wasm-opt: wasm-opt failed');
    expect([...fileSystem.files.keys()].filter((file) => file.includes('/build-cache/wasm-opt/'))).toEqual([]);
    expect(
      Array.from(fileSystem.files.entries()).some(
        ([file, bytes]) => file.includes('/rust-wasm/site-') && bytes.toString().startsWith('old js')
      )
    ).toBe(true);
    expect(
      Array.from(fileSystem.files.entries()).some(
        ([file, bytes]) => file.includes('/rust-wasm/site-') && bytes.toString() === 'old wasm'
      )
    ).toBe(true);
    expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(true);
    await syncDocRuntime(options);
    expect(buildRust).toHaveBeenCalledTimes(3);
    expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(true);
  });

  it('preserves verified Haskell output across tolerated failures and recovers on retry', async () => {
    const { fileSystem, sync } = createRustRuntimeHarness();
    const page = '/repo/content/docs/index.mdx';
    await fileSystem.writeFile(page, '```haskell\n--| id: hs\nputStrLn "first"\n```');
    const buildHaskell = vi.fn(async ({ paths }) => {
      await fileSystem.writeFile(path.join(paths.haskellWasmPublicDir, 'doc_haskell_cells.wasm'), 'verified haskell');
      return { ok: true };
    });
    const options = { buildHaskell, tolerateHaskellBuildFailure: true };
    await sync(options);
    await fileSystem.writeFile(page, '```haskell\n--| id: hs\nputStrLn "edited"\n```');
    for (const attempt of [1, 2]) {
      buildHaskell.mockImplementationOnce(async ({ paths }) => {
        await fileSystem.writeFile(path.join(paths.haskellWasmPublicDir, 'status.json'), 'unavailable');
        return { ok: false, error: new Error(`failed attempt ${attempt}`) };
      });
      await sync(options);
      expect(fileSystem.files.get('/repo/public/oxiquill/haskell-wasm/doc_haskell_cells.wasm').toString()).toBe(
        'verified haskell'
      );
      expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(false);
    }
    await sync(options);
    expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(true);
    expect(buildHaskell).toHaveBeenCalledTimes(4);
  });

  it('publishes Haskell output only for Haskell cells and withholds readiness after a tolerated failure', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/index.mdx': '```haskell\n--| id: hs\nputStrLn "haskell"\n```'
    });
    const buildHaskell = vi.fn(async ({ fileSystem: runtimeFileSystem, paths: runtimePaths }) => {
      await runtimeFileSystem.writeFile(path.join(runtimePaths.haskellWasmPublicDir, 'status.json'), 'unavailable');
      return { error: new Error('compiler failed'), ok: false };
    });

    const result = await syncDocRuntime({
      ...runtimeSyncOptions,
      buildHaskell,
      buildRust: vi.fn(),
      fileSystem,
      helperCrates: new Map(),
      highlighter,
      mode: 'dev',
      paths,
      syncLicenses: async () => false,
      syncPyodide: vi.fn(),
      tolerateHaskellBuildFailure: true
    });

    expect(buildHaskell).toHaveBeenCalledOnce();
    expect(result.haskellBuildResult).toMatchObject({ ok: false });
    expect(fileSystem.existsSync('/repo/public/oxiquill/haskell-wasm/status.json')).toBe(true);
    expect(fileSystem.existsSync('/repo/.oxiquill/generated/runtime-version.ts')).toBe(false);
  });

  it('summarizes cells, decides when Wasm is needed, and builds with injected commands', async () => {
    const cells = [
      { crates: ['doc-rust'], id: 'rust', inputs: [], language: 'rust', source: 'println!("a");' },
      { crates: [], id: 'py', inputs: [], language: 'python', source: 'print("a")' },
      { crates: [], id: 'hs', inputs: [], language: 'haskell', source: 'putStrLn "a"' }
    ];
    const previous = summarizeCells(cells);
    const changed = summarizeCells([{ ...cells[0], source: 'println!("b");' }]);
    const changedHaskell = summarizeCells([{ ...cells[2], source: 'putStrLn "b"' }]);

    expect(stableFingerprint({ b: 2 })).toBe('{"b":2}');
    expect(previous).toMatchObject({ cellCount: 3, haskellCellCount: 1, rustCellCount: 1 });
    expect(
      summarizeCells([
        { id: 'a', language: 'python', packages: ['pandas', 'matplotlib'], source: '' },
        { id: 'b', language: 'python', packages: ['matplotlib'], source: '' }
      ]).pythonPackages
    ).toEqual(['matplotlib', 'pandas']);
    expect(shouldBuildWasm({ current: previous, force: true, previous })).toBe(true);
    expect(shouldBuildWasm({ current: previous })).toBe(true);
    expect(shouldBuildWasm({ changeKinds: new Set(['crate']), current: previous, previous })).toBe(true);
    expect(shouldBuildWasm({ current: changed, previous })).toBe(true);
    expect(shouldBuildWasm({ current: previous, previous })).toBe(false);
    expect(shouldBuildWasm({ current: { ...previous, rustCellCount: 0 }, force: true })).toBe(false);
    expect(shouldBuildHaskellWasm({ current: previous, force: true, previous })).toBe(true);
    expect(shouldBuildHaskellWasm({ current: previous })).toBe(true);
    expect(shouldBuildHaskellWasm({ current: changedHaskell, previous })).toBe(true);
    expect(shouldBuildHaskellWasm({ current: previous, previous })).toBe(false);
    expect(shouldBuildHaskellWasm({ current: { ...previous, haskellCellCount: 0 }, force: true })).toBe(false);

    const commands = [];
    await buildRustWasm({
      wasmOpt: { identity: 'managed-by-wasm-pack' },
      environment: {},
      mode: 'build',
      postprocess: async (options) => {
        commands.push(['postprocess', [], options]);
      },
      root: '/repo',
      runCommand: async (command, args, options) => {
        commands.push([command, args, options]);
      }
    });

    expect(commands).toEqual([
      [
        'wasm-pack',
        [
          'build',
          repoPath('.oxiquill/rust-cells'),
          '--target',
          'web',
          '--release',
          '--out-dir',
          repoPath('public/oxiquill/rust-wasm'),
          '--out-name',
          'doc_rust_cells',
          '--locked'
        ],
        expect.objectContaining({
          cwd: repoRoot,
          env: { CARGO_TARGET_DIR: repoPath('.oxiquill/build-cache/rust-target') }
        })
      ],
      ['postprocess', [], { rustWasmDir: repoPath('public/oxiquill/rust-wasm') }]
    ]);

    commands.length = 0;
    await buildRustWasm({
      wasmOpt: { identity: 'managed-by-wasm-pack' },
      environment: {},
      mode: 'dev',
      postprocess: async () => undefined,
      root: '/repo',
      runCommand: async (command, args, options) => {
        commands.push([command, args, options]);
      }
    });
    expect(commands[0][1]).toContain('--dev');

    commands.length = 0;
    const fileSystem = createMemoryFileSystem();
    await buildHaskellWasm({
      compilerVersion: '9.14.1',
      environment: {},
      fileSystem,
      haskellFingerprint: previous.haskellFingerprint,
      mode: 'build',
      root: '/repo',
      runCommand: async (command, args, options) => {
        commands.push([command, args, options]);
      }
    });
    expect(commands).toEqual([
      [
        'wasm32-wasi-ghc',
        [
          '-O2',
          '-i.',
          '-odir',
          repoPath('.oxiquill/build-cache/haskell/build-9.14.1/objects'),
          '-hidir',
          repoPath('.oxiquill/build-cache/haskell/build-9.14.1/objects'),
          'Main.hs',
          '-o',
          repoPath('public/oxiquill/haskell-wasm/doc_haskell_cells.wasm')
        ],
        expect.objectContaining({ cwd: repoPath('.oxiquill/build-cache/haskell/build-9.14.1/src'), env: {} })
      ]
    ]);
    expect(fileSystem.existsSync('/repo/.oxiquill/build-cache/haskell/build-9.14.1/objects')).toBe(true);
    expect(fileSystem.existsSync('/repo/public/oxiquill/haskell-wasm')).toBe(true);
    expect(JSON.parse(fileSystem.files.get('/repo/public/oxiquill/haskell-wasm/status.json').toString())).toEqual(
      createHaskellRuntimeStatus({
        haskellFingerprint: previous.haskellFingerprint,
        status: 'ready'
      })
    );
  });

  it('fingerprints Haskell builds from semantic toolchain inputs instead of compiler paths', () => {
    const inputs = {
      cells: 'haskell cells',
      runtimeInputs: runtimeInputs.haskell,
      source: 'generated source'
    };
    const first = createHaskellBuildFingerprint({
      ...inputs,
      toolchain: { command: '/opt/first/bin/wasm32-wasi-ghc', version: '9.14.1.20260330' }
    });
    const second = createHaskellBuildFingerprint({
      ...inputs,
      toolchain: { command: '/different/path/wasm32-wasi-ghc', version: '9.14.1.20260330' }
    });

    expect(second).toBe(first);
    expect(
      createHaskellBuildFingerprint({
        ...inputs,
        toolchain: { command: '/opt/first/bin/wasm32-wasi-ghc', version: '9.14.2.20260401' }
      })
    ).not.toBe(first);
    expect(
      createHaskellBuildFingerprint({
        ...inputs,
        runtimeInputs: { ...runtimeInputs.haskell, supportedVersionPrefix: '9.16.' },
        toolchain: { command: '/opt/first/bin/wasm32-wasi-ghc', version: '9.14.1.20260330' }
      })
    ).not.toBe(first);
    expect(createHaskellBuildFingerprint({ ...inputs, source: 'changed source' })).not.toBe(
      createHaskellBuildFingerprint(inputs)
    );
  });

  it('resolves the Haskell compiler and reports strict build failures clearly', async () => {
    expect(resolveHaskellWasiCompiler({})).toBe('wasm32-wasi-ghc');
    expect(resolveHaskellWasiCompiler({ OXIQUILL_HASKELL_GHC: '/opt/ghc/bin/wasm-ghc' })).toBe('/opt/ghc/bin/wasm-ghc');
    expect(resolveHaskellWasiCompiler({ OXIQUILL_HASKELL_GHC: '  ' })).toBe('wasm32-wasi-ghc');

    const missingCompiler = new Error('spawn wasm32-wasi-ghc ENOENT');
    missingCompiler.code = 'ENOENT';

    await expect(
      buildHaskellWasm({
        compilerVersion: '9.14.1',
        environment: {},
        fileSystem: createMemoryFileSystem(),
        mode: 'dev',
        root: '/repo',
        runCommand: async () => {
          throw missingCompiler;
        }
      })
    ).rejects.toThrow(MissingHaskellWasiCompilerError);

    await expect(
      buildHaskellWasm({
        compilerVersion: '9.14.1',
        environment: {},
        fileSystem: createMemoryFileSystem(),
        mode: 'dev',
        root: '/repo',
        runCommand: async () => {
          throw new Error('type error in Main.hs');
        }
      })
    ).rejects.toThrow('Haskell WASI runtime build failed with wasm32-wasi-ghc: type error in Main.hs');
  });

  it('writes unavailable Haskell runtime status and removes stale wasm for tolerated dev failures', async () => {
    const missingCompiler = new Error('spawn wasm32-wasi-ghc ENOENT');
    missingCompiler.code = 'ENOENT';
    const staleWasmPath = `/repo/public/oxiquill/haskell-wasm/${HASKELL_WASM_FILE}`;
    const fileSystem = createMemoryFileSystem({
      [staleWasmPath]: 'stale wasm'
    });
    const result = await buildHaskellWasm({
      compilerVersion: '9.14.1',
      environment: {},
      fileSystem,
      haskellFingerprint: 'current-haskell-fingerprint',
      mode: 'dev',
      root: '/repo',
      runCommand: async () => {
        throw missingCompiler;
      },
      tolerateFailure: true
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(MissingHaskellWasiCompilerError);
    expect(fileSystem.existsSync(staleWasmPath)).toBe(false);
    expect(fileSystem.removals).toEqual([staleWasmPath]);
    expect(JSON.parse(fileSystem.files.get('/repo/public/oxiquill/haskell-wasm/status.json').toString())).toEqual({
      status: 'unavailable',
      haskellFingerprintHash: hashText('current-haskell-fingerprint'),
      message: 'install wasm32-wasi-ghc and rerun pnpm wasm:dev.'
    });
  });
});

describe('production generation checkpoints', () => {
  const original = '```rust\n//| id: rust\n//| crates: []\nprintln!("ok");\n```';
  const page = '/repo/content/docs/index.mdx';
  const cases = [
    ['source', async (fs) => fs.writeFile(page, original.replace('ok', 'new'))],
    ['added', async (fs) => fs.writeFile('/repo/content/docs/new.mdx', original.replace('id: rust', 'id: added'))],
    ['removed', async (fs) => fs.rm(page)],
    [
      'moved',
      async (fs) => {
        await fs.writeFile('/repo/content/docs/moved.mdx', original);
        await fs.rm(page);
      }
    ],
    ['inputs', async (fs) => fs.writeFile(page, (await fs.readFile(page, 'utf8')).replace('value: 1', 'value: 2'))],
    ['helper', async (fs) => fs.writeFile('/repo/crates/helper/src/lib.rs', 'pub fn changed() {}')]
  ];

  it.each(cases)('rejects a %s change behind a compilation barrier and rebuilds settled sources', async (_, edit) => {
    const { buildRust, fileSystem, paths, sync } = createRustRuntimeHarness({
      '/repo/crates/helper/src/lib.rs': 'pub fn original() {}'
    });
    if (_ === 'inputs')
      await fileSystem.writeFile(
        page,
        original.replace('//| crates: []', '//| crates: []\n//| inputs:\n//|   count: { type: number, value: 1 }')
      );
    const first = await sync();
    const previous = new Map(
      [...fileSystem.files].filter(([file]) => file.includes('/generated/') || file.includes('/public/'))
    );
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const compile = buildRust.getMockImplementation();
    buildRust.mockImplementationOnce(async (options) => {
      await compile(options);
      entered.resolve();
      await resume.promise;
    });
    const attempt = sync({ forceRustBuild: true });
    const rejected = expect(attempt).rejects.toThrow(
      'Interactive cell sources changed after runtime generation started.'
    );
    await entered.promise;
    await edit(fileSystem);
    resume.resolve();
    await rejected;
    previous.forEach((bytes, file) => expect(fileSystem.files.get(file)).toEqual(bytes));
    expect([...fileSystem.files.keys()].some((file) => file.includes('.oxiquill-'))).toBe(false);
    const settled = await sync();
    expect(settled.generationId).not.toBe(first.generationId);
    const manifest = JSON.parse(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
    const state = JSON.parse(await fileSystem.readFile(paths.runtimeOwnershipPath, 'utf8'));
    expect(manifest.generationId).toBe(settled.generationId);
    expect(state.generationId).toBe(manifest.generationId);
    expect(state.snapshot.generationId).toBe(manifest.generationId);
    expect(await fileSystem.readFile(paths.runtimeVersionPath, 'utf8')).not.toBe(
      previous.get(memoryPath(paths.runtimeVersionPath)).toString()
    );
    expect(manifest.cells.map(({ source }) => source)).toEqual(
      (await collectCells({ fileSystem, highlighter, paths, helperCrates: new Map() })).map(({ source }) => source)
    );
  });

  it.each(['unchanged', 'prose'])('accepts the %s control and preserves cached outputs', async (kind) => {
    const { buildRust, fileSystem, sync } = createRustRuntimeHarness();
    const first = await sync();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const compile = buildRust.getMockImplementation();
    buildRust.mockImplementationOnce(async (options) => {
      await compile(options);
      entered.resolve();
      await resume.promise;
    });
    const attempt = sync({ forceRustBuild: true });
    await entered.promise;
    if (kind === 'prose') await fileSystem.writeFile(page, `# Edited prose\n\n${original}`);
    resume.resolve();
    expect((await attempt).generationId).toBe(first.generationId);
    const before = buildRust.mock.calls.length;
    expect((await sync()).plan.hasChanges).toBe(false);
    expect(buildRust).toHaveBeenCalledTimes(before);
  });

  it('checks the cache-reuse path before returning success', async () => {
    const { fileSystem, sync } = createRustRuntimeHarness();
    await sync();
    await expect(
      sync({
        syncLicenses: async () => {
          await fileSystem.writeFile(page, original.replace('ok', 'changed'));
          return false;
        }
      })
    ).rejects.toThrow('cell "rust": source');
  });

  it('never publishes readiness for a changed first generation', async () => {
    const { buildRust, fileSystem, paths, sync } = createRustRuntimeHarness();
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const compile = buildRust.getMockImplementation();
    buildRust.mockImplementationOnce(async (options) => {
      await compile(options);
      entered.resolve();
      await resume.promise;
    });
    const attempt = sync();
    const rejected = expect(attempt).rejects.toThrow('cell "rust": source');
    await entered.promise;
    await fileSystem.writeFile(page, original.replace('ok', 'changed'));
    resume.resolve();
    await rejected;
    expect(fileSystem.existsSync(paths.runtimeVersionPath)).toBe(false);
    expect(fileSystem.existsSync(paths.cellsJsonPath)).toBe(false);
    expect(fileSystem.existsSync(paths.runtimeOwnershipPath)).toBe(false);
    expect(fileSystem.existsSync(paths.rustWasmPublicDir)).toBe(false);
    expect([...fileSystem.files.keys()].some((file) => file.includes('.oxiquill-'))).toBe(false);
  });

  it('discards a cancelled private attempt and preserves the previous ready runtime', async () => {
    const { buildRust, fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const before = await fileSystem.readFile(paths.runtimeVersionPath, 'utf8');
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    buildRust.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
    });
    const attempt = sync({ forceRustBuild: true });
    const rejected = expect(attempt).rejects.toThrow('cancelled');
    await entered.promise;
    resume.reject(new Error('cancelled'));
    await rejected;
    expect(await fileSystem.readFile(paths.runtimeVersionPath, 'utf8')).toBe(before);
    expect([...fileSystem.files.keys()].some((file) => file.includes('.oxiquill-'))).toBe(false);
  });

  it('withdraws readiness during publication and rolls back every output if promotion fails', async () => {
    const { fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const before = new Map(fileSystem.files);
    const rename = fileSystem.rename;
    let failed = false;
    fileSystem.rename = async (from, to) => {
      if (!failed && to === paths.rustWasmPublicDir) {
        expect(fileSystem.existsSync(paths.runtimeVersionPath)).toBe(false);
      }
      if (!failed && to === paths.generatedDir) {
        failed = true;
        throw new Error('promotion failed');
      }
      await rename(from, to);
    };
    await expect(sync({ forceRustBuild: true })).rejects.toThrow('promotion failed');
    expect(fileSystem.files).toEqual(before);
    await expect(sync()).resolves.toMatchObject({ plan: { hasChanges: false } });
  });
});

describe('Rust registry publication', () => {
  it('rejects invalid published assignments and repairs missing legacy registry metadata without recompiling', async () => {
    const { buildRust, fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const manifest = JSON.parse(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
    await fileSystem.writeFile(paths.cellsJsonPath, JSON.stringify({ ...manifest, rust: { version: 1, modules: [] } }));
    await expect(sync()).rejects.toThrow('missing cells:');
    const { rust, ...legacy } = manifest;
    expect(rust.modules).toHaveLength(1);
    await fileSystem.writeFile(paths.cellsJsonPath, JSON.stringify(legacy));
    await sync();
    expect(JSON.parse(await fileSystem.readFile(paths.cellsJsonPath, 'utf8')).rust).toEqual(rust);
    expect(buildRust).toHaveBeenCalledOnce();
  });

  it('publishes new assets before the registry, retires old registered files afterward, and preserves unrelated files', async () => {
    const { fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const previous = JSON.parse(await fileSystem.readFile(paths.cellsJsonPath, 'utf8')).rust;
    const oldFiles = previous.modules.flatMap((module) =>
      [module.glue, module.wasm].map((asset) => path.join(paths.publicDir, asset.url))
    );
    const unrelated = path.join(paths.rustWasmPublicDir, 'keep.txt');
    await fileSystem.writeFile(unrelated, 'authored');
    let published = false;
    const rename = fileSystem.rename;
    fileSystem.rename = async (from, to) => {
      if (to === paths.generatedDir) {
        const next = JSON.parse(await fileSystem.readFile(path.join(from, 'cells.json'), 'utf8')).rust;
        oldFiles.forEach((file) => expect(fileSystem.existsSync(file)).toBe(true));
        next.modules.forEach((module) =>
          [module.glue, module.wasm].forEach((asset) =>
            expect(fileSystem.existsSync(path.join(paths.publicDir, asset.url))).toBe(true)
          )
        );
        published = true;
      }
      await rename(from, to);
    };
    const remove = fileSystem.rm;
    fileSystem.rm = async (file, options) => {
      if (oldFiles.includes(file)) expect(published).toBe(true);
      await remove(file, options);
    };
    await sync({
      forceRustBuild: true,
      buildRust: async ({ paths: staged }) => {
        await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells.js'), 'replacement glue');
        await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'), 'replacement wasm');
      }
    });
    expect(published).toBe(true);
    oldFiles.forEach((file) => expect(fileSystem.existsSync(file)).toBe(false));
    expect(await fileSystem.readFile(unrelated, 'utf8')).toBe('authored');
    const state = JSON.parse(await fileSystem.readFile(paths.runtimeOwnershipPath, 'utf8'));
    expect(state.ownedOutputs.filter((entry) => entry.language === 'rust' && entry.root === 'public')).toHaveLength(2);
    await expect(sync()).resolves.toMatchObject({ plan: { hasChanges: false } });
  });

  it('retains assets referenced by the committed registry when backup cleanup fails', async () => {
    const { fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const remove = fileSystem.rm;
    fileSystem.rm = async (file, options) => {
      if (file.endsWith('.previous')) throw new Error('backup cleanup failed');
      await remove(file, options);
    };
    await expect(
      sync({
        forceRustBuild: true,
        buildRust: async ({ paths: staged }) => {
          await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells.js'), 'committed glue');
          await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'), 'committed wasm');
        }
      })
    ).rejects.toThrow('backup cleanup failed');
    const manifest = JSON.parse(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
    for (const module of manifest.rust.modules)
      for (const asset of [module.glue, module.wasm])
        expect(fileSystem.existsSync(path.join(paths.publicDir, asset.url))).toBe(true);
  });

  it('rolls back newly installed immutable files when registry publication fails', async () => {
    const { fileSystem, paths, sync } = createRustRuntimeHarness();
    await sync();
    const before = new Map(fileSystem.files);
    const rename = fileSystem.rename;
    fileSystem.rename = async (from, to) => {
      if (to === paths.generatedDir && !from.endsWith('.previous')) throw new Error('registry publication failed');
      await rename(from, to);
    };
    await expect(
      sync({
        forceRustBuild: true,
        buildRust: async ({ paths: staged }) => {
          await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells.js'), 'different glue');
          await fileSystem.writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'), 'different wasm');
        }
      })
    ).rejects.toThrow('registry publication failed');
    expect(fileSystem.files).toEqual(before);
  });
});

describe('staged runtime license inputs', () => {
  it('collects notices from new outputs before promotion and preserves unrelated license files', async () => {
    const { fileSystem, paths, sync } = createRustRuntimeHarness();
    await fileSystem.writeFile(path.join(paths.licensesPublicDir, 'keep.txt'), 'keep');
    const syncLicenses = async ({ paths: staged }) => {
      expect(staged.rustWasmPublicDir).not.toBe(paths.rustWasmPublicDir);
      expect(
        (await fileSystem.readdir(staged.rustWasmPublicDir, { withFileTypes: true })).some((entry) =>
          entry.name.endsWith('.wasm')
        )
      ).toBe(true);
      expect(fileSystem.existsSync(paths.runtimeVersionPath)).toBe(false);
      await fileSystem.writeFile(path.join(staged.licensesPublicDir, 'notices.txt'), 'next notices');
      return true;
    };
    await sync({ syncLicenses });
    expect(await fileSystem.readFile(path.join(paths.licensesPublicDir, 'keep.txt'), 'utf8')).toBe('keep');
    expect(await fileSystem.readFile(path.join(paths.licensesPublicDir, 'notices.txt'), 'utf8')).toBe('next notices');
    await fileSystem.rm('/repo/content/docs/index.mdx');
    await sync({
      syncLicenses: async ({ paths: staged }) => {
        expect(fileSystem.existsSync(path.join(staged.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'))).toBe(false);
        return false;
      }
    });
  });
});
