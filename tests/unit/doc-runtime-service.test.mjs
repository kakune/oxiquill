import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  postprocessRustWasm,
  removeUnusedWasmPackState,
  stripUnusedWasmPackState
} from '../../packages/oxiquill/src/generator/postprocess-rust-wasm.mjs';
import {
  buildRustWasm,
  collectCells,
  copyFileIfChanged,
  copyPyodideAssets,
  copyVendoredPyodidePackages,
  createRuntimeVersion,
  createDocRuntimeContext,
  createDocRuntimePaths,
  generateRuntimeVersionModule,
  hashBytes,
  hashText,
  listFiles,
  listHelperCrates,
  markRuntimeReady,
  readHelperManifests,
  resolveVendoredPyodidePackages,
  shouldBuildWasm,
  stableFingerprint,
  summarizeCells,
  syncDocRuntime,
  writeIfChanged
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';
import { pathFromUrl } from '../../packages/oxiquill/src/config/paths.mjs';

function memoryPath(filePath) {
  return String(filePath).replaceAll('\\', '/');
}

function repoPath(...segments) {
  return path.join('/repo', ...segments);
}

function createMemoryFileSystem(initialFiles = {}) {
  const files = new Map();
  const directories = new Set(['/repo', '/repo/src', '/repo/src/content', '/repo/content/docs']);
  const writes = [];
  const copies = [];

  function ensureParents(filePath) {
    const parts = memoryPath(filePath).split('/').filter(Boolean);
    let current = '';
    for (const part of parts.slice(0, -1)) {
      current += `/${part}`;
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
    writes
  };
}

const highlighter = {
  codeToHtml: (source, options) => Promise.resolve(`<pre data-lang="${options.lang}">${source}</pre>`)
};

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

    expect(removals).toEqual([['/repo/pkg/.gitignore', { force: true }]]);
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
      pyodidePublicDir: pathFromUrl(paths.pyodidePublicDir),
      rustCellsDir: pathFromUrl(paths.rustCellsDir),
      runtimeVersionPath: pathFromUrl(paths.runtimeVersionPath)
    }).toEqual({
      docsDir: repoPath('content/docs'),
      generatedDir: repoPath('.oxiquill/generated'),
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
      root: '/repo'
    });

    expect(Array.from(context.helperCrates.keys())).toEqual(['doc-rust']);
    await expect(
      createDocRuntimeContext({
        fileSystem,
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
    await expect(listHelperCrates({ paths, readManifests: async () => [] })).resolves.toEqual(
      new Map()
    );

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
    await expect(readHelperManifests({ fileSystem: unreadableDirectory, paths })).rejects.toThrow(
      'permission denied'
    );

    const unreadableManifest = {
      readdir: async () => [{ isDirectory: () => true, name: 'doc-rust' }],
      readFile: async () => {
        const error = new Error('broken manifest');
        error.code = 'EIO';
        throw error;
      }
    };
    await expect(readHelperManifests({ fileSystem: unreadableManifest, paths })).rejects.toThrow(
      'broken manifest'
    );
  });

  it('lists files recursively and collects interactive cells', async () => {
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/index.mdx': 'plain',
      '/repo/content/docs/note.mdx': '```rust\n//| id: a\n//| crates: []\nprintln!("a");\n```',
      '/repo/content/docs/deep/page.md': '```python\n#| id: b\nprint("b")\n```'
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
    ).resolves.toMatchObject([{ id: 'deep__page__b' }, { id: 'note__a' }]);

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
    ).rejects.toThrow(
      'Rust cell "a" in content/docs/page.mdx references unknown crate "missing-helper"'
    );
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
    ).rejects.toThrow(
      'Python cell "py" in content/docs/page.mdx specifies unsupported packages: scipy'
    );
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
    await expect(copyFileIfChanged('/repo/source.bin', '/repo/target.bin', { fileSystem: failingBinary })).rejects.toThrow(
      'broken read'
    );
  });

  it('copies Pyodide assets when present and skips when absent', async () => {
    const paths = createDocRuntimePaths('/repo');
    const absent = createMemoryFileSystem();
    await expect(copyPyodideAssets({ fileSystem: absent, paths, root: '/repo' })).resolves.toBe(false);

    const lockFile = {
      packages: {
        matplotlib: pyodidePackage('matplotlib', 'matplotlib.whl', 'matplotlib bytes'),
        pandas: pyodidePackage('pandas', 'pandas.whl', 'pandas bytes')
      }
    };
    const present = createMemoryFileSystem(
      Object.fromEntries(
        [
          'pyodide.mjs',
          'pyodide.mjs.map',
          'pyodide.asm.js',
          'pyodide.asm.wasm',
          'python_stdlib.zip',
          ['pyodide-lock.json', JSON.stringify(lockFile)]
        ].map((file) => Array.isArray(file) ? [`/repo/node_modules/pyodide/${file[0]}`, file[1]] : [`/repo/node_modules/pyodide/${file}`, file])
      )
    );
    const fetched = {
      'matplotlib.whl': Buffer.from('matplotlib bytes'),
      'pandas.whl': Buffer.from('pandas bytes')
    };
    const fetchPackage = async (fileName) => fetched[fileName];

    await expect(copyPyodideAssets({ fetchPackage, fileSystem: present, paths, root: '/repo' })).resolves.toBe(true);
    expect(present.files.get('/repo/public/oxiquill/pyodide/matplotlib.whl')).toEqual(Buffer.from('matplotlib bytes'));
    expect(present.files.get('/repo/public/oxiquill/pyodide/pandas.whl')).toEqual(Buffer.from('pandas bytes'));
    await expect(copyPyodideAssets({ fetchPackage, fileSystem: present, paths, root: '/repo' })).resolves.toBe(false);
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

    expect(resolveVendoredPyodidePackages(lockFile, ['root']).map((entry) => entry.name)).toEqual(['dep', 'leaf', 'root']);
    await expect(copyVendoredPyodidePackages({
      fetchPackage: async (fileName) => fetched[fileName],
      fileSystem,
      lockFile,
      paths,
      roots: ['root']
    })).resolves.toBe(true);
    await expect(copyVendoredPyodidePackages({
      fetchPackage: async (fileName) => fetched[fileName],
      fileSystem,
      lockFile,
      paths,
      roots: ['root']
    })).resolves.toBe(false);

    expect(() => resolveVendoredPyodidePackages({}, ['root'])).toThrow('missing a packages table');
    expect(() => resolveVendoredPyodidePackages({ packages: {} }, ['missing'])).toThrow(
      'Pyodide package "missing" is missing'
    );
    await expect(copyVendoredPyodidePackages({
      fetchPackage: async () => Buffer.from('changed'),
      fileSystem: createMemoryFileSystem(),
      lockFile,
      paths,
      roots: ['root']
    })).rejects.toThrow('has sha256');

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
    await expect(copyVendoredPyodidePackages({
      fetchPackage: async (fileName) => fetched[fileName],
      fileSystem: readFailure,
      lockFile,
      paths,
      roots: ['root']
    })).rejects.toThrow('permission denied');
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
        ok: true,
        arrayBuffer: async () => Buffer.from('root bytes')
      };
    };
    try {
      await expect(copyVendoredPyodidePackages({
        fileSystem: createMemoryFileSystem(),
        lockFile,
        paths,
        roots: ['root']
      })).resolves.toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(requestedUrls).toEqual(['https://cdn.jsdelivr.net/pyodide/v0.29.4/full/root.whl']);

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      statusText: 'unavailable'
    });
    try {
      await expect(copyVendoredPyodidePackages({
        fileSystem: createMemoryFileSystem(),
        lockFile,
        paths,
        roots: ['root']
      })).rejects.toThrow('503 unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('syncs generated runtime files and reports changed surfaces', async () => {
    const paths = createDocRuntimePaths('/repo');
    const fileSystem = createMemoryFileSystem({
      '/repo/content/docs/page.mdx': '```rust\n//| id: a\n//| crates: [doc-rust]\nprintln!("a");\n```'
    });
    const helperCrates = await listHelperCrates({
      fileSystem: createMemoryFileSystem({
        '/repo/crates/doc-rust/Cargo.toml': '[package]\nname = "doc-rust"\n'
      }),
      paths,
      root: '/repo'
    });

    const first = await syncDocRuntime({
      fileSystem,
      helperCrates,
      highlighter,
      paths,
      root: '/repo'
    });

    expect(first).toMatchObject({
      cellCount: 1,
      cellsChanged: true,
      pyodideChanged: false,
      rustCellCount: 1,
      rustChanged: true
    });
    expect(fileSystem.writes.sort()).toEqual([
      '/repo/.oxiquill/generated/cells.ts',
      '/repo/.oxiquill/generated/cells.json',
      '/repo/.oxiquill/rust-cells/Cargo.toml',
      '/repo/.oxiquill/rust-cells/src/lib.rs'
    ].sort());

    await expect(markRuntimeReady({ fileSystem, paths, summary: first, version: 'ready-1' })).resolves.toBe(true);
    expect(fileSystem.files.get('/repo/.oxiquill/generated/runtime-version.ts').toString()).toContain(
      'ready-1'
    );
    expect(generateRuntimeVersionModule('ready-2')).toContain('ready-2');
    expect(hashText('runtime')).toHaveLength(64);

    const runtimeVersion = JSON.parse(createRuntimeVersion({
      manifestFingerprint: 'manifest',
      rustFingerprint: 'rust'
    }));
    expect(runtimeVersion.manifest).toBe(hashText('manifest'));
    expect(runtimeVersion.rust).toBe(hashText('rust'));

    const emptyRuntimeVersion = JSON.parse(createRuntimeVersion());
    expect(emptyRuntimeVersion.manifest).toBe(hashText(''));
    expect(emptyRuntimeVersion.rust).toBe(hashText(''));

    fileSystem.writes.length = 0;
    await expect(
      syncDocRuntime({
        fileSystem,
        helperCrates,
        highlighter,
        paths,
        root: '/repo'
      })
    ).resolves.toMatchObject({
      cellsChanged: false,
      rustChanged: false
    });
    expect(fileSystem.writes).toEqual([]);
  });

  it('summarizes cells, decides when Wasm is needed, and builds with injected commands', async () => {
    const cells = [
      { crates: ['doc-rust'], id: 'rust', inputs: [], language: 'rust', source: 'println!("a");' },
      { crates: [], id: 'py', inputs: [], language: 'python', source: 'print("a")' }
    ];
    const previous = summarizeCells(cells);
    const changed = summarizeCells([{ ...cells[0], source: 'println!("b");' }]);

    expect(stableFingerprint({ b: 2 })).toBe('{"b":2}');
    expect(previous).toMatchObject({ cellCount: 2, rustCellCount: 1 });
    expect(shouldBuildWasm({ current: previous, force: true, previous })).toBe(true);
    expect(shouldBuildWasm({ current: previous })).toBe(true);
    expect(shouldBuildWasm({ changeKinds: new Set(['crate']), current: previous, previous })).toBe(true);
    expect(shouldBuildWasm({ current: changed, previous })).toBe(true);
    expect(shouldBuildWasm({ current: previous, previous })).toBe(false);
    expect(shouldBuildWasm({ current: { ...previous, rustCellCount: 0 }, force: true })).toBe(false);

    const commands = [];
    await buildRustWasm({
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
          '/repo/.oxiquill/rust-cells',
          '--target',
          'web',
          '--release',
          '--out-dir',
          '/repo/public/oxiquill/rust-wasm',
          '--out-name',
          'doc_rust_cells'
        ],
        { cwd: '/repo' }
      ],
      ['postprocess', [], { rustWasmDir: '/repo/public/oxiquill/rust-wasm' }]
    ]);

    commands.length = 0;
    await buildRustWasm({
      mode: 'dev',
      postprocess: async () => undefined,
      root: '/repo',
      runCommand: async (command, args, options) => {
        commands.push([command, args, options]);
      }
    });
    expect(commands[0][1]).toContain('--dev');
  });
});
