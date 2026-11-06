// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';
import { hashBytes } from '../../packages/oxiquill/src/generator/doc-runtime/hashing.mjs';
import { buildRustWasm } from '../../packages/oxiquill/src/generator/doc-runtime/wasm-build.mjs';
import { readRustBuildInputs } from '../../packages/oxiquill/src/generator/doc-runtime/build-inputs.mjs';
import {
  binaryenEnvironment,
  cacheEntriesToRemove,
  optimizeRustWasmFiles,
  pruneWasmOptCache,
  resolveWasmOpt,
  wasmOptCacheKey
} from '../../packages/oxiquill/src/generator/doc-runtime/wasm-opt-cache.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const optimizer = { command: '/tools/wasm-opt', identity: { version: 'wasm-opt 117\n', sha256: 'executable hash' } };
const input = Buffer.from('unoptimized');
const output = Buffer.from('optimized');
const failure = (code) => Object.assign(new Error(code), { code });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-wasm-opt-'));
  roots.push(root);
  const directory = path.join(root, 'stage');
  const cacheDir = path.join(root, 'cache');
  await mkdir(directory);
  const file = path.join(directory, 'runtime.wasm');
  await writeFile(file, input);
  const runCommand = vi.fn(async (_command, args) => writeFile(args[2], output));
  return { root, directory, cacheDir, file, runCommand, optimizer, environment: {} };
}
async function entries(cacheDir) {
  return (await readdir(cacheDir)).filter((name) => name.endsWith('.wasm'));
}

describe('optimizer identity and keys', () => {
  it('keys every optimizer input and excludes unrelated environment and property order', () => {
    const options = { input, identity: optimizer.identity };
    const original = wasmOptCacheKey(options);
    for (const change of [
      { input: Buffer.from('edited') },
      { identity: { ...optimizer.identity, version: '118\n' } },
      { identity: { ...optimizer.identity, sha256: 'edited executable' } },
      { args: ['-O2'] },
      { environment: { BINARYEN_CORES: '2' } },
      { schema: 2 }
    ])
      expect(wasmOptCacheKey({ ...options, ...change })).not.toBe(original);
    expect(wasmOptCacheKey({ ...options, environment: { OTHER: 'ignored', BINARYEN_CORES: undefined } })).toBe(
      original
    );
    expect(binaryenEnvironment({ BINARYEN_Z: 'z', BINARYEN_A: 'a' })).toEqual({ BINARYEN_A: 'a', BINARYEN_Z: 'z' });
    expect(wasmOptCacheKey({ ...options, environment: { BINARYEN_A: 'a', BINARYEN_Z: 'z' } })).toBe(
      wasmOptCacheKey({ ...options, environment: { BINARYEN_Z: 'z', BINARYEN_A: 'a' } })
    );
  });

  it('resolves the first executable, records full version and bytes, and supports memoized production reads', async () => {
    const { root } = await fixture();
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    const command = path.join(bin, process.platform === 'win32' ? 'wasm-opt.EXE' : 'wasm-opt');
    await writeFile(command, 'first binary');
    await chmod(command, 0o755);
    const runCommand = vi.fn(async () => 'wasm-opt 117\nfull output\n');
    const options = { environment: { PATH: `${root}${path.delimiter}${bin}` }, runCommand };
    const first = await resolveWasmOpt(options);
    expect(first).toEqual({
      command,
      identity: { version: 'wasm-opt 117\nfull output\n', sha256: hashBytes('first binary') }
    });
    await writeFile(command, 'second binary');
    expect((await resolveWasmOpt(options)).identity).not.toEqual(first.identity);
    const cached = await resolveWasmOpt({ ...options, memoize: true });
    expect(await resolveWasmOpt({ ...options, memoize: true })).toBe(cached);
    await rm(command);
    expect(await resolveWasmOpt(options)).toEqual({ identity: 'managed-by-wasm-pack' });
    expect(await resolveWasmOpt({ ...options, environment: {} })).toEqual({ identity: 'managed-by-wasm-pack' });
  });

  it('uses Windows PATH casing, PATHEXT order and the requested working directory', async () => {
    const calls = [];
    const fileSystem = {
      stat: async (command) => {
        calls.push(command);
        if (!command.endsWith('.EXE')) throw failure('ENOENT');
        return { isFile: () => true };
      },
      access: vi.fn(),
      readFile: async () => input
    };
    const result = await resolveWasmOpt({
      platform: 'win32',
      cwd: 'C:\\project',
      environment: { Path: 'tools;C:\\other', Pathext: '.COM;.EXE' },
      fileSystem,
      runCommand: async () => '117'
    });
    expect(result.command).toBe('C:\\project\\tools\\wasm-opt.EXE');
    expect(calls).toEqual(['C:\\project\\tools\\wasm-opt.COM', 'C:\\project\\tools\\wasm-opt.EXE']);
  });

  it('skips directories and nonexecutables and propagates identity errors', async () => {
    const options = { environment: { PATH: '/bin' }, runCommand: async () => '117' };
    expect(await resolveWasmOpt({ ...options, fileSystem: { stat: async () => ({ isFile: () => false }) } })).toEqual({
      identity: 'managed-by-wasm-pack'
    });
    expect(
      await resolveWasmOpt({
        ...options,
        fileSystem: {
          stat: async () => {
            throw failure('EACCES');
          }
        }
      })
    ).toEqual({ identity: 'managed-by-wasm-pack' });
    await expect(
      resolveWasmOpt({
        ...options,
        fileSystem: {
          stat: async () => {
            throw failure('EIO');
          }
        }
      })
    ).rejects.toThrow('EIO');
  });

  it('invalidates whole-runtime reuse for Binaryen environment changes', async () => {
    const { root } = await fixture();
    const paths = createOxiquillPaths({ workspaceRoot: root });
    expect(await readRustBuildInputs({ paths, environment: { BINARYEN_CORES: '2' } })).not.toBe(
      await readRustBuildInputs({ paths, environment: {} })
    );
  });
});

describe('verified optimizer cache', () => {
  it('reuses verified bytes, refreshes recency, and never links the stage to the cache', async () => {
    const options = await fixture();
    await optimizeRustWasmFiles(options);
    const [entry] = await entries(options.cacheDir);
    const cached = path.join(options.cacheDir, entry);
    await utimes(cached, new Date(0), new Date(0));
    await writeFile(options.file, input);
    await optimizeRustWasmFiles(options);
    expect(options.runCommand).toHaveBeenCalledOnce();
    expect(await readFile(options.file)).toEqual(output);
    expect((await stat(cached)).mtimeMs).toBeGreaterThan(0);
    await writeFile(options.file, 'mutated stage');
    expect(await readFile(cached)).toEqual(output);
  });

  it.each(['edited bytes', ''])('removes corrupt entries and reoptimizes: %j', async (corrupt) => {
    const options = await fixture();
    await optimizeRustWasmFiles(options);
    const [entry] = await entries(options.cacheDir);
    await writeFile(path.join(options.cacheDir, entry), corrupt);
    await writeFile(options.file, input);
    await optimizeRustWasmFiles(options);
    expect(options.runCommand).toHaveBeenCalledTimes(2);
    expect(await entries(options.cacheDir)).toEqual([entry]);
    expect(await readFile(path.join(options.cacheDir, entry))).toEqual(output);
  });

  it('allows concurrent misses to publish one immutable entry', async () => {
    const first = await fixture();
    const second = await fixture();
    let arrivals = 0;
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    const runCommand = vi.fn(async (_command, args) => {
      arrivals += 1;
      if (arrivals === 2) release();
      await ready;
      await writeFile(args[2], output);
    });
    await Promise.all(
      [first, second].map((options) => optimizeRustWasmFiles({ ...options, cacheDir: first.cacheDir, runCommand }))
    );
    expect(await entries(first.cacheDir)).toHaveLength(1);
    expect(await readFile(first.file)).toEqual(output);
    expect(await readFile(second.file)).toEqual(output);
    expect(await readdir(first.cacheDir)).toHaveLength(1);
  });

  it.each(['mkdir', 'readdir', 'open', 'link'])(
    'publishes optimized output despite cache %s failures',
    async (operation) => {
      const options = await fixture();
      const fileSystem = {
        ...defaultFileSystem,
        [operation]: async (...args) => {
          if (String(args[0]).startsWith(options.cacheDir)) throw failure('EACCES');
          return defaultFileSystem[operation](...args);
        }
      };
      await optimizeRustWasmFiles({ ...options, fileSystem });
      expect(await readFile(options.file)).toEqual(output);
      expect(options.runCommand).toHaveBeenCalledOnce();
    }
  );

  it('preserves verified hits when recency cannot be updated', async () => {
    const options = await fixture();
    await optimizeRustWasmFiles(options);
    await writeFile(options.file, input);
    await optimizeRustWasmFiles({
      ...options,
      fileSystem: {
        ...defaultFileSystem,
        utimes: async () => {
          throw failure('EACCES');
        }
      }
    });
    expect(options.runCommand).toHaveBeenCalledOnce();
    expect(await readFile(options.file)).toEqual(output);
  });

  it('fails on optimizer failure without storing output or retaining temporary files', async () => {
    const options = await fixture();
    await expect(
      optimizeRustWasmFiles({
        ...options,
        runCommand: async () => {
          throw new Error('optimization failed');
        }
      })
    ).rejects.toThrow('/tools/wasm-opt: optimization failed');
    expect(await readdir(options.cacheDir)).toEqual([]);
    expect(await readFile(options.file)).toEqual(input);
  });

  it('prunes oldest entries and abandoned temporary files while tolerating concurrent disappearance', async () => {
    const { cacheDir } = await fixture();
    await mkdir(cacheDir);
    const now = Date.now();
    const names = Array.from({ length: 18 }, (_, index) => `${hashBytes(String(index))}.${hashBytes(output)}.wasm`);
    await Promise.all(
      names.map(async (name, index) => {
        const file = path.join(cacheDir, name);
        await writeFile(file, output);
        await utimes(file, new Date(index * 1000), new Date(index * 1000));
      })
    );
    await writeFile(path.join(cacheDir, '.tmp-old'), input);
    await utimes(path.join(cacheDir, '.tmp-old'), new Date(0), new Date(0));
    await writeFile(path.join(cacheDir, '.tmp-active'), input);
    await mkdir(path.join(cacheDir, 'unrelated-directory'));
    const fileSystem = {
      ...defaultFileSystem,
      stat: async (file) => {
        if (file.endsWith(names[0])) {
          await rm(file, { force: true });
          throw failure('ENOENT');
        }
        return stat(file);
      },
      rm: async (file, options) => {
        await rm(file, options);
        await rm(file, options);
      }
    };
    await pruneWasmOptCache({ cacheDir, now, fileSystem });
    expect((await entries(cacheDir)).sort()).toEqual(names.slice(2).sort());
    expect(await readdir(cacheDir)).toContain('.tmp-active');
    expect(await readdir(cacheDir)).not.toContain('.tmp-old');
    expect(cacheEntriesToRemove([{ name: '.tmp-active', mtimeMs: now }], now)).toEqual([]);
  });
});

describe('wasm-pack integration', () => {
  it.each(['dev', 'build'])('preserves the original %s invocation without a PATH optimizer', async (mode) => {
    const { root } = await fixture();
    const paths = createOxiquillPaths({ workspaceRoot: root });
    const runCommand = vi.fn();
    await buildRustWasm({ mode, paths, environment: {}, runCommand, postprocess: vi.fn() });
    expect(runCommand).toHaveBeenCalledExactlyOnceWith(
      'wasm-pack',
      [
        'build',
        paths.rustCellsDir,
        '--target',
        'web',
        mode === 'build' ? '--release' : '--dev',
        '--out-dir',
        paths.rustWasmPublicDir,
        '--out-name',
        'doc_rust_cells',
        '--locked'
      ],
      { cwd: root, env: { CARGO_TARGET_DIR: paths.rustTargetDir } }
    );
  });

  it('optimizes every Wasm before postprocessing and skips optimization in dev', async () => {
    const options = await fixture();
    const paths = {
      ...createOxiquillPaths({ workspaceRoot: options.root }),
      rustWasmPublicDir: options.directory,
      wasmOptCacheDir: options.cacheDir
    };
    await writeFile(path.join(options.directory, 'second.wasm'), 'different input');
    await writeFile(path.join(options.directory, 'glue.js'), 'untouched');
    const postprocess = vi.fn(async () => expect(await readFile(options.file)).toEqual(output));
    const runCommand = vi.fn(async (command, args) => {
      if (command === 'wasm-pack') {
        expect(args.indexOf('--no-opt')).toBeLessThan(args.indexOf('--locked'));
        expect(args).toContain('--no-opt');
        return;
      }
      expect(args.at(-1)).toBe('-O');
      await writeFile(args[2], output);
    });
    await buildRustWasm({ paths, mode: 'build', wasmOpt: optimizer, runCommand, postprocess, environment: {} });
    expect(runCommand).toHaveBeenCalledTimes(3);
    expect(postprocess).toHaveBeenCalledOnce();
    const devRunner = vi.fn();
    await buildRustWasm({
      paths,
      mode: 'dev',
      wasmOpt: optimizer,
      runCommand: devRunner,
      postprocess: vi.fn(),
      environment: {}
    });
    expect(devRunner).toHaveBeenCalledOnce();
    expect(devRunner.mock.calls[0][1]).not.toContain('--no-opt');
  });
});
