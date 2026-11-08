// @vitest-environment node
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { retryFileOperation } from '../../packages/oxiquill/src/generator/doc-runtime/atomic-output.mjs';
import {
  cdylibWasm,
  isBuildScriptMessage,
  isErrorMessage,
  messageGroup,
  parseCargoMessage
} from '../../packages/oxiquill/src/generator/doc-runtime/cargo-messages.mjs';
import { createFileDigests, isFileRecord } from '../../packages/oxiquill/src/generator/doc-runtime/file-digests.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';
import { hashBytes } from '../../packages/oxiquill/src/generator/doc-runtime/hashing.mjs';
import { createProcessRunner } from '../../packages/oxiquill/src/generator/doc-runtime/process-runner.mjs';
import {
  createRuntimeSession,
  toolchainProbeKey
} from '../../packages/oxiquill/src/generator/doc-runtime/runtime-session.mjs';
import {
  readRustFailures,
  readRustWorkspaceRecords,
  writeRustFailures,
  writeRustWorkspaceRecords
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-build-records.mjs';
import {
  composeRustManifest,
  failedRustBlocks
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-manifest-compose.mjs';
import {
  collectRustModuleGarbage,
  installRustModuleFiles,
  referencedRustFiles
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-module-publish.mjs';
import { createTaskPool } from '../../packages/oxiquill/src/generator/doc-runtime/task-pool.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-primitives-'));
  roots.push(root);
  return root;
}

describe('task pool', () => {
  it('bounds concurrency, keeps failures with their task, and drains', async () => {
    const pool = createTaskPool(2);
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers());
    let active = 0;
    const seen = [];
    const tasks = gates.map((gate, index) =>
      pool.run(async () => {
        active += 1;
        seen.push(active);
        await gate.promise;
        active -= 1;
        if (index === 1) throw new Error('task failed');
        return index;
      })
    );
    gates.forEach((gate) => gate.resolve());
    await pool.idle();
    expect(Math.max(...seen)).toBe(2);
    expect(pool.maxActive).toBe(2);
    await expect(tasks[0]).resolves.toBe(0);
    await expect(tasks[1]).rejects.toThrow('task failed');
    expect(() => createTaskPool(0)).toThrow('positive integer');
  });
});

describe('file digests', () => {
  it('hashes each file once per run and verifies by size in development and by hash in builds', async () => {
    const root = await temporary();
    const file = path.join(root, 'module.wasm');
    await writeFile(file, 'original');
    const reads = vi.fn(defaultFileSystem.readFile);
    const fileSystem = { ...defaultFileSystem, readFile: reads };
    const build = createFileDigests({ fileSystem, mode: 'build' });
    const record = await build.record(file);
    expect(record).toEqual({ size: 8, sha256: hashBytes(Buffer.from('original')) });
    expect(await build.digest(file)).toBe(record.sha256);
    expect(reads).toHaveBeenCalledOnce();
    await writeFile(file, 'modified');
    expect(await createFileDigests({ fileSystem, mode: 'build' }).verify(file, record)).toBe(false);
    reads.mockClear();
    const dev = createFileDigests({ fileSystem, mode: 'dev' });
    expect(await dev.verify(file, record)).toBe(true);
    expect(reads).not.toHaveBeenCalled();
    expect(await dev.verify(path.join(root, 'missing'), record)).toBe(false);
    expect(await dev.verify(file, { size: 1 })).toBe(false);
    const described = dev.describe(file, Buffer.from('modified'));
    expect(await dev.verify(file, described)).toBe(true);
    expect(isFileRecord(described)).toBe(true);
    expect(isFileRecord({ size: -1, sha256: described.sha256 })).toBe(false);
    const memory = createFileDigests({ fileSystem: { readFile: async () => Buffer.from('memory') }, mode: 'dev' });
    expect(await memory.verify('/memory', { size: 6, sha256: hashBytes(Buffer.from('memory')) })).toBe(true);
    const failing = createFileDigests({
      fileSystem: {
        stat: async () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      },
      mode: 'dev'
    });
    await expect(failing.verify('/denied', record)).rejects.toThrow('denied');
  });
});

describe('Cargo messages', () => {
  it('parses JSON lines and attributes them without parsing package ids', () => {
    expect(parseCargoMessage('   Compiling serde')).toBeUndefined();
    expect(parseCargoMessage('{broken')).toBeUndefined();
    expect(parseCargoMessage('{"no":"reason"}')).toBeUndefined();
    expect(parseCargoMessage(' {"reason":"build-finished","success":true}\r')).toEqual({
      reason: 'build-finished',
      success: true
    });
    const group = { id: 'page-0123456789abcdef', crateName: 'doc_rust_page_0123456789abcdef' };
    const lookup = { byCrate: new Map([[group.crateName, group]]), byId: new Map([[group.id, group]]) };
    expect(messageGroup({ target: { name: group.crateName } }, lookup)).toBe(group);
    expect(
      messageGroup(
        { manifest_path: `\\\\?\\C:\\book\\.oxiquill\\rust-cells\\modules\\${group.id}\\Cargo.toml` },
        lookup
      )
    ).toBe(group);
    expect(messageGroup({ manifest_path: `/book/crates/${group.id}/Cargo.toml` }, lookup)).toBeUndefined();
    expect(cdylibWasm({ target: { kind: ['rlib'] }, filenames: ['a.wasm'] })).toBeUndefined();
    expect(cdylibWasm({ target: { crate_types: ['cdylib'] }, filenames: ['a.rlib', 'a.wasm'] })).toBe('a.wasm');
    expect(isErrorMessage({ reason: 'compiler-message', message: { level: 'error: internal compiler error' } })).toBe(
      true
    );
    expect(isErrorMessage({ reason: 'compiler-message', message: { level: 'warning' } })).toBe(false);
    expect(isBuildScriptMessage({ target: { kind: ['custom-build'] } })).toBe(true);
  });
});

describe('streamed process output', () => {
  it('delivers complete stdout lines to a consumer without echoing or capturing them', async () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const run = createProcessRunner({
      spawnProcess: () => child,
      stdout,
      stderr,
      setTimer: () => 0,
      clearTimer: () => {}
    });
    const lines = [];
    const running = run('cargo', ['build'], { onStdoutLine: (line) => lines.push(line) });
    child.stdout.emit('data', Buffer.from('{"a":1}\r\n{"b":'));
    child.stdout.emit('data', Buffer.from([0x32, 0x7d, 0x0a, 0xe6, 0x97]));
    child.stdout.emit('data', Buffer.from([0xa5]));
    child.stderr.emit('data', Buffer.from('   Compiling x\n'));
    child.emit('close', 0, null);
    await expect(running).resolves.toBe('');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '日']);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledOnce();

    const failing = createProcessRunner({
      spawnProcess: () => child,
      stdout,
      stderr,
      setTimer: () => 0,
      clearTimer: () => {}
    });
    child.removeAllListeners();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    const rejected = failing('cargo', [], {
      onStdoutLine: () => {
        throw new Error('consumer failed');
      }
    });
    child.stdout.emit('data', Buffer.from('line\n'));
    await expect(rejected).rejects.toThrow('consumer failed');
    expect(child.kill).toHaveBeenCalled();
  });
});

describe('development manifest composition', () => {
  const cell = (id, pagePath, extra = {}) => ({ id, pagePath, language: 'rust', source: id, ...extra });
  const module = (id, cells) => ({ id, cells, glue: { url: `x/${id}.js` }, wasm: { url: `x/${id}.wasm` } });

  it('keeps the last working module and previous Rust entries of failing pages', () => {
    const previousManifest = {
      cells: [cell('a__one', 'a.mdx', { source: 'old' }), cell('a__gone', 'a.mdx'), cell('b__one', 'b.mdx')],
      definitions: [{ id: 'a__defs', pagePath: 'a.mdx', language: 'rust', kind: 'definitions' }]
    };
    const groups = [
      { id: 'g-a', status: 'failed', cells: [cell('a__one', 'a.mdx'), cell('a__new', 'a.mdx')] },
      { id: 'g-b', status: 'built', cells: [cell('b__one', 'b.mdx')], module: module('g-b', ['b__one']) },
      { id: 'g-c', status: 'failed', cells: [cell('c__one', 'c.mdx')] }
    ];
    const cells = [
      cell('a__one', 'a.mdx', { source: 'new' }),
      cell('a__new', 'a.mdx'),
      { id: 'a__python', pagePath: 'a.mdx', language: 'python' },
      cell('b__one', 'b.mdx'),
      cell('c__one', 'c.mdx')
    ];
    const composed = composeRustManifest({
      cells,
      definitions: [{ id: 'a__defs', pagePath: 'a.mdx', language: 'rust', kind: 'definitions', source: 'new' }],
      groups,
      previousManifest,
      previousModules: new Map([['g-a', module('g-a', ['a__one', 'a__gone', 'b__one'])]])
    });
    expect(composed.cells.map((entry) => [entry.id, entry.source])).toEqual([
      ['a__python', undefined],
      ['b__one', 'b__one'],
      ['a__one', 'old'],
      ['a__gone', 'a__gone']
    ]);
    expect(composed.definitions).toEqual(previousManifest.definitions);
    expect(composed.registry.modules.map((entry) => [entry.id, entry.cells])).toEqual([
      ['g-a', ['a__gone', 'a__one']],
      ['g-b', ['b__one']]
    ]);
    expect(composed.retained).toEqual(['g-a']);
    expect(
      composeRustManifest({
        cells: composed.cells,
        definitions: composed.definitions,
        groups,
        previousManifest: { cells: composed.cells, definitions: composed.definitions },
        previousModules: new Map(composed.registry.modules.map((entry) => [entry.id, entry]))
      }).registry
    ).toEqual(composed.registry);
    expect(
      failedRustBlocks([...cells, { id: 'a__defs', pagePath: 'a.mdx', language: 'rust' }], groups).map(
        (block) => block.id
      )
    ).toEqual(['a__one', 'a__new', 'c__one', 'a__defs']);
  });
});

describe('development session', () => {
  it('memoizes parses, highlights, and toolchain probes and drops unused entries', async () => {
    const session = createRuntimeSession();
    const parse = vi.fn((source, pagePath) => ({ cells: [source], diagnostics: [], page: { pagePath }, tree: {} }));
    const highlight = vi.fn(async (source) => `<${source}>`);
    const highlighter = session.highlighter({ codeToHtml: highlight, dispose: vi.fn() });
    expect(session.highlighter(highlighter)).toBe(highlighter);
    session.beginSync();
    const parsePage = session.parsePage(parse);
    expect(parsePage('a', 'a.mdx', {})).toEqual({ cells: ['a'], diagnostics: [], page: { pagePath: 'a.mdx' } });
    parsePage('a', 'a.mdx', {});
    parsePage('b', 'b.mdx', {});
    await highlighter.codeToHtml('x', { lang: 'rust' });
    await highlighter.codeToHtml('x', { lang: 'rust' });
    session.endSync();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(highlight).toHaveBeenCalledOnce();
    session.beginSync();
    parsePage('changed', 'a.mdx', {});
    session.endSync();
    session.beginSync();
    parsePage('b', 'b.mdx', {});
    expect(parse).toHaveBeenCalledTimes(4);
    highlighter.dispose();

    const probe = vi.fn(async () => ({ rust: {} }));
    const key = toolchainProbeKey({ environment: { PATH: '/bin' }, toolchainFiles: [], flags: { mode: 'dev' } });
    await session.toolchain(key, probe);
    await session.toolchain(key, probe);
    expect(probe).toHaveBeenCalledOnce();
    expect(
      toolchainProbeKey({ environment: { PATH: '/usr/bin' }, toolchainFiles: [], flags: { mode: 'dev' } })
    ).not.toBe(key);
    session.clearToolchains();
    await session.toolchain(key, probe);
    const failing = vi.fn().mockRejectedValueOnce(new Error('missing cargo')).mockResolvedValue({});
    await expect(session.toolchain('other', failing)).rejects.toThrow('missing cargo');
    await session.toolchain('other', failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('Rust asset publication', () => {
  it('installs only new or invalid content-addressed files and collects unreferenced assets', async () => {
    const root = await temporary();
    const stage = path.join(root, 'stage');
    const target = path.join(root, 'rust-wasm');
    await mkdir(stage, { recursive: true });
    await mkdir(target, { recursive: true });
    const name = (id, ext) => `${id}-${'a'.repeat(64)}.${ext}`;
    const files = {
      [name('page-1', 'js')]: 'glue',
      [name('page-1', 'wasm')]: 'wasm',
      [name('page-2', 'wasm')]: 'fresh'
    };
    for (const [file, text] of Object.entries(files)) await writeFile(path.join(stage, file), text);
    await writeFile(path.join(target, name('page-1', 'wasm')), 'wasm');
    await writeFile(path.join(target, name('page-2', 'wasm')), 'corrupt');
    const records = Object.fromEntries(
      Object.entries(files).map(([file, text]) => [file, { size: text.length, sha256: hashBytes(Buffer.from(text)) }])
    );
    const digests = createFileDigests({ fileSystem: defaultFileSystem, mode: 'build' });
    const installed = await installRustModuleFiles({
      stageDir: stage,
      targetDir: target,
      files: records,
      digests,
      fileSystem: defaultFileSystem
    });
    expect(installed).toEqual([path.join(target, name('page-1', 'js'))]);
    expect(await readFile(path.join(target, name('page-2', 'wasm')), 'utf8')).toBe('fresh');
    await writeFile(path.join(target, 'notes.txt'), 'authored');
    await writeFile(path.join(target, 'doc_rust_cells.js'), 'legacy');
    await writeFile(path.join(target, name('site', 'js')), 'old');
    const registry = {
      modules: [{ glue: { url: `x/${name('page-1', 'js')}` }, wasm: { url: `x/${name('page-1', 'wasm')}` } }]
    };
    const removed = await collectRustModuleGarbage({
      targetDir: target,
      referenced: referencedRustFiles(registry),
      fileSystem: defaultFileSystem
    });
    expect(removed).toEqual(['doc_rust_cells.js', name('page-2', 'wasm'), name('site', 'js')]);
    expect((await readdir(target)).sort()).toEqual(['notes.txt', name('page-1', 'js'), name('page-1', 'wasm')]);
    const report = vi.fn();
    await collectRustModuleGarbage({
      targetDir: target,
      referenced: new Set(),
      fileSystem: {
        readdir: async () => [name('page-1', 'js')],
        rm: async () => {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
      },
      events: { report }
    });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'diagnostic', message: expect.stringContaining('busy') })
    );
    expect(
      await collectRustModuleGarbage({
        targetDir: path.join(root, 'absent'),
        referenced: new Set(),
        fileSystem: defaultFileSystem
      })
    ).toEqual([]);
  });

  it('retries transient Windows file errors only on Windows', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'EBUSY' });
    const action = vi.fn().mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockResolvedValue('done');
    const delay = vi.fn(async () => undefined);
    await expect(retryFileOperation(action, { platform: 'win32', delay })).resolves.toBe('done');
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([25, 50]);
    await expect(retryFileOperation(vi.fn().mockRejectedValue(busy), { platform: 'linux', delay })).rejects.toBe(busy);
    await expect(
      retryFileOperation(vi.fn().mockRejectedValue(busy), { platform: 'win32', attempts: 2, delay })
    ).rejects.toBe(busy);
  });
});

describe('Rust build records', () => {
  it('round-trips records and ignores corrupt files and unsafe ids', async () => {
    const root = await temporary();
    const paths = createOxiquillPaths({ workspaceRoot: root });
    const fileSystem = defaultFileSystem;
    expect(await readRustWorkspaceRecords({ paths, fileSystem })).toEqual({ lock: undefined, modules: {} });
    const id = 'page-0123456789abcdef';
    await writeRustWorkspaceRecords({
      paths,
      fileSystem,
      records: { lock: { inputFingerprint: 'x' }, modules: { [id]: { inputFingerprint: 'a' }, '../escape': { x: 1 } } }
    });
    expect(await readRustWorkspaceRecords({ paths, fileSystem })).toEqual({
      lock: { inputFingerprint: 'x' },
      modules: { [id]: { inputFingerprint: 'a' } }
    });
    await writeRustFailures({
      paths,
      fileSystem,
      failures: { [id]: { fingerprint: 'f' }, site: { fingerprint: 'g' } }
    });
    expect(await readRustFailures({ paths, fileSystem })).toEqual({ [id]: { fingerprint: 'f' } });
    await writeRustFailures({ paths, fileSystem, failures: {} });
    expect(await readRustFailures({ paths, fileSystem })).toEqual({});
    await writeFile(path.join(paths.buildCacheDir, 'rust-failures.json'), '{');
    expect(await readRustFailures({ paths, fileSystem })).toEqual({});
    await expect(
      readRustWorkspaceRecords({
        paths,
        fileSystem: {
          readFile: async () => {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
          }
        }
      })
    ).rejects.toThrow('denied');
  });
});
