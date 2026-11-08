// @vitest-environment node
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { createRuntimeEvents } from '../../packages/oxiquill/src/generator/doc-runtime/runtime-events.mjs';
import {
  buildRustModules,
  cargoBuildArguments,
  cargoBuildSelection
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-module-build.mjs';
import { rustGroupPackage } from '../../packages/oxiquill/src/generator/doc-runtime/rust-grouping.mjs';
import { postLinkParallelism, wasmOptThreads } from '../../packages/oxiquill/src/generator/doc-runtime/task-pool.mjs';

const paths = createOxiquillPaths({ workspaceRoot: path.resolve('/book') });
const group = (index) => {
  const id = `page-${String(index).padStart(16, '0')}`;
  return {
    id,
    pages: [`p${index}.mdx`],
    ...rustGroupPackage(id),
    sourceDir: path.join(paths.rustCellsDir, 'modules', id)
  };
};
const artifact = (entry, extra = {}) =>
  JSON.stringify({
    reason: 'compiler-artifact',
    package_id: `path+file:///book/.oxiquill/rust-cells/modules/${entry.id}#${entry.packageName}@0.4.1`,
    manifest_path: path.join(entry.sourceDir, 'Cargo.toml'),
    target: { name: entry.crateName, kind: ['cdylib', 'rlib'], crate_types: ['cdylib', 'rlib'] },
    filenames: [`/target/${entry.crateName}.rlib`, `/target/${entry.crateName}.wasm`],
    fresh: false,
    ...extra
  });
const compilerError = (target, extra = {}) =>
  JSON.stringify({
    reason: 'compiler-message',
    package_id: 'opaque',
    target: { name: target, kind: ['lib'], src_path: '/src/lib.rs' },
    message: {
      level: 'error',
      message: `broken ${target}`,
      spans: [],
      children: [],
      rendered: `error: broken ${target}\n`
    },
    ...extra
  });
const toolchain = {
  wasmBindgen: { command: '/tools/wasm-bindgen', identity: { version: '0.2.129' } },
  wasmOpt: { command: '/tools/wasm-opt', identity: { version: '117' } }
};

function harness({
  lines = [],
  cargoFailure,
  gate = Promise.resolve(),
  bindgenGate,
  parallelism = { pool: 4, cores: 8 }
} = {}) {
  const timeline = [];
  let active = 0;
  let maxActive = 0;
  const runCommand = vi.fn(async (command, args, options) => {
    if (command === 'cargo') {
      timeline.push('cargo:start');
      for (const line of lines) options.onStdoutLine(line);
      await gate;
      timeline.push('cargo:exit');
      if (cargoFailure) throw cargoFailure;
      return '';
    }
    active += 1;
    maxActive = Math.max(maxActive, active);
    timeline.push(`bindgen:${path.basename(args[0])}`);
    await bindgenGate?.();
    active -= 1;
    return '';
  });
  const finalize = vi.fn(async (entry) => ({ module: { id: entry.id }, files: {} }));
  const optimize = vi.fn(async () => undefined);
  const prune = vi.fn(async () => undefined);
  const fileSystem = { rm: vi.fn(async () => undefined), mkdir: vi.fn(async () => undefined) };
  const stderr = { write: vi.fn(), isTTY: false };
  const build = (options = {}) =>
    buildRustModules({
      groups: options.groups,
      paths,
      stageDir: '/stage',
      mode: options.mode ?? 'dev',
      toolchain,
      finalize,
      environment: options.environment ?? {},
      fileSystem,
      runCommand,
      events: options.events ?? createRuntimeEvents(),
      format: options.format ?? 'human',
      stderr,
      parallelism,
      ensureTool: options.ensureTool ?? vi.fn(async () => undefined),
      optimize,
      prune,
      ...options.overrides
    });
  return { build, runCommand, timeline, finalize, optimize, prune, stderr, maxActive: () => maxActive };
}

describe('Cargo invocation', () => {
  it('selects stale modules plus helper representatives and falls back to the workspace', () => {
    const members = [1, 2, 3].map(group);
    expect(
      cargoBuildSelection({ stale: [members[1]], members, representatives: ['doc-rust-page-0000000000000003'] })
    ).toEqual(['--package', members[1].packageName, '--package', 'doc-rust-page-0000000000000003']);
    expect(cargoBuildSelection({ stale: members, members, exclude: ['x'] })).toEqual(['--workspace', '--exclude', 'x']);
    const many = Array.from({ length: 1200 }, (_, index) => group(index));
    expect(cargoBuildSelection({ stale: many.slice(0, 900), members: many })).toEqual(['--workspace']);
    expect(cargoBuildArguments({ paths, mode: 'build', selection: ['--workspace'] })).toEqual([
      'build',
      '--manifest-path',
      path.join(paths.rustCellsDir, 'Cargo.toml'),
      '--target',
      'wasm32-unknown-unknown',
      '--locked',
      '--keep-going',
      '--message-format=json',
      '--release',
      '--workspace'
    ]);
  });

  it('derives the post-link pool and optimizer threads from the job settings', () => {
    expect(postLinkParallelism({}, 8)).toEqual({ pool: 8, cores: 8 });
    expect(postLinkParallelism({ CARGO_BUILD_JOBS: '3' }, 8)).toEqual({ pool: 3, cores: 8 });
    expect(postLinkParallelism({ CARGO_BUILD_JOBS: '-2' }, 8)).toEqual({ pool: 6, cores: 8 });
    expect(postLinkParallelism({ CARGO_BUILD_JOBS: '-20' }, 8)).toEqual({ pool: 1, cores: 8 });
    expect(postLinkParallelism({ CARGO_BUILD_JOBS: 'default' }, 0)).toEqual({ pool: 1, cores: 1 });
    expect(wasmOptThreads({ cores: 16, pool: 4, staleCount: 1 })).toBe(16);
    expect(wasmOptThreads({ cores: 16, pool: 4, staleCount: 10 })).toBe(4);
    expect(wasmOptThreads({ cores: 2, pool: 8, staleCount: 8 })).toBe(1);
  });
});

describe('streaming post-link work', () => {
  it('starts post-link work before Cargo exits and never exceeds the pool', async () => {
    const groups = [1, 2, 3, 4, 5].map(group);
    const cargo = Promise.withResolvers();
    const bindgen = Promise.withResolvers();
    const test = harness({
      lines: ['not json', '{"reason":"build-script-executed"}', ...groups.map((entry) => artifact(entry))],
      gate: cargo.promise,
      bindgenGate: () => bindgen.promise,
      parallelism: { pool: 2, cores: 8 }
    });
    const running = test.build({ groups });
    await vi.waitFor(() =>
      expect(test.runCommand.mock.calls.filter(([command]) => command !== 'cargo')).toHaveLength(2)
    );
    expect(test.timeline).not.toContain('cargo:exit');
    bindgen.resolve();
    cargo.resolve();
    const result = await running;
    expect(test.maxActive()).toBe(2);
    expect(result.maxConcurrency).toBe(2);
    expect(result.results.map((entry) => [entry.group.id, entry.ok])).toEqual(groups.map((entry) => [entry.id, true]));
    expect(test.finalize).toHaveBeenCalledTimes(5);
    const bindgenArgs = test.runCommand.mock.calls.find(([command]) => command === toolchain.wasmBindgen.command)[1];
    expect(bindgenArgs).toEqual([
      `/target/${groups[0].crateName}.wasm`,
      '--target',
      'web',
      '--no-typescript',
      '--out-dir',
      path.join('/stage', groups[0].id),
      '--out-name',
      'doc_rust_cells',
      '--debug',
      '--keep-debug'
    ]);
  });

  it('downloads tools while Cargo compiles and finishes them before post-link work', async () => {
    const download = Promise.withResolvers();
    const order = [];
    const ensureTool = vi.fn(async (tool) => {
      order.push(`download:${tool.version}`);
      await download.promise;
      order.push('downloaded');
    });
    const entry = group(1);
    const test = harness({ lines: [artifact(entry)] });
    const running = test.build({
      groups: [entry],
      mode: 'build',
      ensureTool,
      overrides: {
        toolchain: {
          wasmBindgen: { ...toolchain.wasmBindgen, url: 'https://example.com/b', version: 'b' },
          wasmOpt: { ...toolchain.wasmOpt, url: 'https://example.com/o', version: 'o' }
        }
      }
    });
    await vi.waitFor(() => expect(test.timeline).toContain('cargo:exit'));
    expect(test.timeline.some((step) => step.startsWith('bindgen'))).toBe(false);
    download.resolve();
    await running;
    expect(order).toEqual(['download:b', 'download:o', 'downloaded', 'downloaded']);
    expect(test.optimize).toHaveBeenCalledWith(
      expect.objectContaining({ prune: false, environment: expect.objectContaining({ BINARYEN_CORES: '8' }) })
    );
    expect(test.prune).toHaveBeenCalledWith(expect.objectContaining({ keep: 2 }));
  });

  it('keeps an explicit BINARYEN_CORES and shares cores between stale modules', async () => {
    const groups = [1, 2, 3, 4].map(group);
    const first = harness({ lines: groups.map((entry) => artifact(entry)), parallelism: { pool: 2, cores: 8 } });
    await first.build({ groups, mode: 'build' });
    expect(first.optimize.mock.calls.every(([options]) => options.environment.BINARYEN_CORES === '4')).toBe(true);
    const second = harness({ lines: [artifact(groups[0])] });
    await second.build({ groups: [groups[0]], mode: 'build', environment: { BINARYEN_CORES: '3' } });
    expect(second.optimize.mock.calls[0][0].environment.BINARYEN_CORES).toBe('3');
  });

  it('returns results in group order regardless of completion order', async () => {
    const groups = [1, 2, 3].map(group);
    const delays = new Map([
      [groups[0].crateName, 30],
      [groups[1].crateName, 0],
      [groups[2].crateName, 10]
    ]);
    const test = harness({ lines: [...groups].reverse().map((entry) => artifact(entry)) });
    test.runCommand.mockImplementation(async (command, args, options) => {
      if (command === 'cargo') {
        for (const line of [...groups].reverse().map((entry) => artifact(entry))) options.onStdoutLine(line);
        return '';
      }
      await new Promise((resolve) => setTimeout(resolve, delays.get(path.basename(args[0], '.wasm'))));
      return '';
    });
    const result = await test.build({ groups: [...groups].reverse() });
    expect(result.results.map((entry) => entry.group.id)).toEqual(groups.map((entry) => entry.id));
  });
});

describe('runners without line streaming', () => {
  it('reads artifacts and errors from captured Cargo output', async () => {
    const [built, broken] = [1, 2].map(group);
    const test = harness();
    test.runCommand.mockImplementation(async (command) => {
      if (command !== 'cargo') return '';
      const error = new Error('cargo exited with 101');
      error.stdout = [
        artifact(built),
        compilerError(broken.crateName),
        '{"reason":"build-finished","success":false}'
      ].join('\r\n');
      throw error;
    });
    const failed = await test.build({ groups: [built, broken] });
    expect(failed.results.map((entry) => [entry.ok, entry.kind])).toEqual([
      [true, undefined],
      [false, 'compile']
    ]);
    const captured = harness();
    captured.runCommand.mockImplementation(async (command) => (command === 'cargo' ? `${artifact(built)}\n` : ''));
    expect((await captured.build({ groups: [built] })).results[0].ok).toBe(true);
  });
});

describe('failure attribution', () => {
  it('attributes compiler errors by crate or manifest and keeps independent modules', async () => {
    const [broken, fine, byManifest] = [1, 2, 3].map(group);
    const cargoFailure = Object.assign(new Error('cargo exited with 101'), { exitCode: 101 });
    const test = harness({
      lines: [
        compilerError(broken.crateName),
        compilerError('other_target', { manifest_path: path.join(byManifest.sourceDir, 'Cargo.toml') }),
        JSON.stringify({
          reason: 'compiler-message',
          target: { name: fine.crateName },
          message: { level: 'warning', rendered: 'warning: unused\n' }
        }),
        artifact(fine),
        artifact(fine, { fresh: true }),
        JSON.stringify({ reason: 'build-finished', success: false })
      ],
      cargoFailure
    });
    const result = await test.build({ groups: [broken, fine, byManifest] });
    expect(result.results.map((entry) => [entry.group.id, entry.ok, entry.kind])).toEqual([
      [broken.id, false, 'compile'],
      [fine.id, true, undefined],
      [byManifest.id, false, 'compile']
    ]);
    expect(result.results[0].messages[0]).toMatchObject({
      message: `broken ${broken.crateName}`,
      targetFile: '/src/lib.rs'
    });
    expect(result.results[0].error).toBe(cargoFailure);
    expect(test.finalize).toHaveBeenCalledOnce();
    expect(test.stderr.write).toHaveBeenCalledWith('warning: unused\n');
  });

  it('reports dependency failures, build-script failures, and fatal Cargo errors separately', async () => {
    const entry = group(1);
    const dependency = harness({
      lines: [compilerError('helper'), JSON.stringify({ reason: 'build-finished', success: false })],
      cargoFailure: new Error('cargo exited with 101')
    });
    const dependent = await dependency.build({ groups: [entry] });
    expect(dependent.results[0]).toMatchObject({ ok: false, kind: 'dependency', messages: [] });
    expect(dependent.dependencyMessages[0]).toMatchObject({ target: 'helper', buildScript: false });

    const script = harness({
      lines: [
        compilerError('build_script_build', { target: { name: 'build_script_build', kind: ['custom-build'] } }),
        JSON.stringify({ reason: 'build-finished', success: false })
      ],
      cargoFailure: new Error('cargo exited with 101')
    });
    expect((await script.build({ groups: [entry] })).results[0].kind).toBe('cargo');

    const fatal = harness({ cargoFailure: new Error('failed to select a version for `serde`') });
    const result = await fatal.build({ groups: [entry] });
    expect(result.results[0]).toMatchObject({
      ok: false,
      kind: 'cargo',
      error: { message: expect.stringContaining('serde') }
    });
  });

  it('reports post-link tool failures for their module only', async () => {
    const groups = [1, 2].map(group);
    const test = harness({ lines: groups.map((entry) => artifact(entry)) });
    test.runCommand.mockImplementation(async (command, args, options) => {
      if (command === 'cargo') {
        groups.forEach((entry) => options.onStdoutLine(artifact(entry)));
        return '';
      }
      if (args[0].includes(groups[0].crateName)) throw new Error('wasm-bindgen schema mismatch');
      return '';
    });
    const result = await test.build({ groups });
    expect(result.results.map((entry) => [entry.ok, entry.kind])).toEqual([
      [false, 'tool'],
      [true, undefined]
    ]);
    expect(result.results[0].error.message).toBe('wasm-bindgen schema mismatch');
  });

  it('renders compiler output as events in JSON mode, waits for post-link work on cancellation, and requires tools', async () => {
    const entry = group(1);
    const output = [];
    const events = createRuntimeEvents({ report: (event) => output.push(event) });
    const json = harness({ lines: [compilerError(entry.crateName)], cargoFailure: new Error('cargo exited with 101') });
    await json.build({ groups: [entry], format: 'json', events });
    expect(output).toContainEqual(
      expect.objectContaining({
        type: 'output',
        source: 'rustc',
        stream: 'stderr',
        line: `error: broken ${entry.crateName}`
      })
    );
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    await expect(harness({ cargoFailure: abort }).build({ groups: [entry] })).rejects.toBe(abort);
    await expect(harness().build({ groups: [entry], overrides: { toolchain: {} } })).rejects.toThrow(
      'pinned wasm-bindgen CLI'
    );
    await expect(
      harness().build({
        groups: [entry],
        mode: 'build',
        overrides: { toolchain: { wasmBindgen: toolchain.wasmBindgen } }
      })
    ).rejects.toThrow('require wasm-opt');
    expect(await harness().build({ groups: [] })).toEqual({ results: [], dependencyMessages: [], maxConcurrency: 0 });
  });
});
