// @vitest-environment node
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDocRuntimeContext,
  createRuntimeSession,
  syncDocRuntime
} from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';
import { normalizeRustOptions } from '../../packages/oxiquill/src/config/metadata.mjs';
import { createRuntimeEvents } from '../../packages/oxiquill/src/generator/doc-runtime/runtime-events.mjs';
import { rustGroupId } from '../../packages/oxiquill/src/generator/doc-runtime/rust-grouping.mjs';
import { createFakeLockResolver, createFakeRustBuilder } from './support/rust-builder.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function page(source, crates = [], id = 'example') {
  return `---\ntitle: Test\n---\n\n\`\`\`rust\n//| id: ${id}\n//| crates: ${JSON.stringify(crates)}\n${source}\n\`\`\`\n`;
}

const compileError = (cellId) => ({
  messages: [
    {
      level: 'error',
      message: 'mismatched types',
      spans: [{ file_name: 'src/lib.rs', byte_start: 0, byte_end: 1, is_primary: true }],
      children: [],
      rendered: `error: mismatched types in ${cellId}`
    }
  ]
});

async function fixture({ helpers = false, grouping = 'page', pages } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-group-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  const put = async (file, source) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  for (const [file, source] of Object.entries(
    pages ?? {
      'content/docs/first.mdx': page('println!("first");', helpers ? ['alpha'] : []),
      'content/docs/second.mdx': page('println!("second");', helpers ? ['beta'] : [])
    }
  ))
    await put(file, source);
  if (helpers) {
    await put(
      'crates/Cargo.toml',
      '[workspace]\nmembers = ["alpha", "beta", "shared"]\n[workspace.dependencies]\nshared = { path = "shared" }\n'
    );
    await put(
      'crates/alpha/Cargo.toml',
      '[package]\nname = "alpha"\nversion = "0.1.0"\n[dependencies]\nshared.workspace = true\n'
    );
    await put('crates/beta/Cargo.toml', '[package]\nname = "beta"\nversion = "0.1.0"\n');
    await put('crates/shared/Cargo.toml', '[package]\nname = "shared"\nversion = "0.1.0"\n');
    for (const name of ['alpha', 'beta', 'shared']) await put(`crates/${name}/src/lib.rs`, `pub fn ${name}() {}`);
  }
  let failing = new Map();
  const buildRust = createFakeRustBuilder({
    fileSystem: defaultFileSystem,
    fail: (group) => group.cells.map((cell) => failing.get(cell.id)).find(Boolean)
  });
  const resolveRustLock = createFakeLockResolver(defaultFileSystem);
  const preflightToolchains = vi.fn(async () => ({ rust: { version: 'test' } }));
  const session = createRuntimeSession();
  const context = ({ session, highlighter } = {}) =>
    createDocRuntimeContext({
      paths,
      rustOptions: { grouping },
      highlighter: highlighter ?? { codeToHtml: async (source) => `<pre>${source}</pre>` },
      ...(session ? { session } : {})
    });
  const sync = async ({ session: activeSession, highlighter, ...options } = {}) =>
    syncDocRuntime({
      ...(await context({ session: activeSession, highlighter })),
      buildRust,
      resolveRustLock,
      generatorIdentity: async () => 'fixture-generator',
      preflightToolchains,
      syncLicenses: async () => false,
      environment: {},
      mode: 'dev',
      ...options
    });
  const state = async () => JSON.parse(await readFile(paths.runtimeOwnershipPath, 'utf8'));
  const manifest = async () => JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
  const rebuilt = (result) =>
    result.plan.rustGroups
      .filter((group) => group.public === 'build')
      .flatMap((group) => group.pages)
      .sort();
  return {
    root,
    paths,
    put,
    sync,
    state,
    manifest,
    rebuilt,
    buildRust,
    resolveRustLock,
    preflightToolchains,
    session,
    fail: (entries) => {
      failing = new Map(Object.entries(entries));
    }
  };
}

describe('Rust module grouping options', () => {
  it('defaults to page grouping and accepts every grouping mode', () => {
    const custom = ({ path: pagePath }) => pagePath.split('/')[0];
    expect(normalizeRustOptions()).toEqual({ grouping: 'page' });
    for (const grouping of ['page', 'directory', 'site', custom])
      expect(normalizeRustOptions({ grouping })).toEqual({ grouping });
    for (const grouping of ['pages', null, 1, ''])
      expect(() => normalizeRustOptions({ grouping })).toThrow("'page', 'directory', 'site', or a function");
    expect(() => normalizeRustOptions({ other: true })).toThrow('Unknown rust option: other');
  });
});

describe('Rust module groups', () => {
  it('reuses source-only generation and subsequently builds its missing modules', async () => {
    const project = await fixture();
    await project.sync({ mode: undefined });
    expect(project.buildRust).not.toHaveBeenCalled();
    expect(project.resolveRustLock).not.toHaveBeenCalled();
    expect((await project.sync({ mode: undefined })).plan.hasChanges).toBe(false);
    const built = await project.sync();
    expect(built.plan.rustGroups.every((group) => group.source === 'keep' && group.public === 'build')).toBe(true);
    expect(project.resolveRustLock).toHaveBeenCalledOnce();
    expect((await project.state()).rust.modules).toHaveLength(2);
  });

  it.each(['dev', 'build'])('rebuilds exactly the edited group in %s mode', async (mode) => {
    const project = await fixture();
    await project.sync({ mode });
    const before = await project.state();
    const unchanged = before.rust.modules.find((module) => module.cells.some((id) => id.includes('second')));
    const bytes = await readFile(path.join(project.paths.publicDir, unchanged.wasm.url));
    project.buildRust.mockClear();
    await project.put('content/docs/first.mdx', page('println!("edited");'));
    const result = await project.sync({ mode });
    expect(project.rebuilt(result)).toEqual(['first.mdx']);
    expect(project.buildRust.mock.calls[0][0].groups.map((group) => group.pages)).toEqual([['first.mdx']]);
    // Editing a cell body changes no Cargo manifest, so the lock is not resolved again.
    expect(project.resolveRustLock).toHaveBeenCalledOnce();
    const after = await project.state();
    expect(after.rust.modules.find((module) => module.id === unchanged.id)).toEqual(unchanged);
    expect(after.languages.rust.groups[unchanged.id]).toEqual(before.languages.rust.groups[unchanged.id]);
    expect(await readFile(path.join(project.paths.publicDir, unchanged.wasm.url))).toEqual(bytes);
    project.buildRust.mockClear();
    const kept = await project.sync({ mode });
    expect(project.buildRust).not.toHaveBeenCalled();
    expect(kept.plan.hasChanges).toBe(false);
  });

  it('never reads, copies, or rewrites other groups in development', async () => {
    const project = await fixture({
      pages: Object.fromEntries(
        ['a', 'b', 'c'].map((name) => [`content/docs/${name}.mdx`, page(`println!("${name}");`)])
      )
    });
    await project.sync();
    const state = await project.state();
    const untouched = state.rust.modules.filter((module) => !module.cells.some((id) => id.startsWith('a__')));
    const protectedPaths = untouched.flatMap((module) => [
      path.join(project.paths.rustCellsDir, 'modules', module.id),
      ...[module.glue, module.wasm].map((asset) => path.join(project.paths.publicDir, asset.url))
    ]);
    const touched = [];
    const spy =
      (name) =>
      async (file, ...rest) => {
        const target = String(file);
        if (protectedPaths.some((protectedPath) => target.startsWith(protectedPath))) touched.push([name, target]);
        return defaultFileSystem[name](file, ...rest);
      };
    const fileSystem = {
      ...defaultFileSystem,
      ...Object.fromEntries(
        ['readFile', 'writeFile', 'copyFile', 'rename', 'rm', 'open', 'link', 'utimes'].map((name) => [name, spy(name)])
      ),
      createReadStream: (file, ...rest) => {
        if (protectedPaths.some((protectedPath) => String(file).startsWith(protectedPath)))
          touched.push(['createReadStream', String(file)]);
        return defaultFileSystem.createReadStream(file, ...rest);
      }
    };
    await project.put('content/docs/a.mdx', page('println!("edited");'));
    const result = await project.sync({ fileSystem });
    expect(project.rebuilt(result)).toEqual(['a.mdx']);
    expect(touched).toEqual([]);
  });

  it('spawns no process and reuses parse, highlight, and toolchain work for a no-op development sync', async () => {
    const project = await fixture();
    const runCommand = vi.fn(async () => {
      throw new Error('unexpected process');
    });
    const highlight = vi.fn(async (source) => `<pre>${source}</pre>`);
    const options = { session: project.session, runCommand, highlighter: { codeToHtml: highlight } };
    await project.sync(options);
    const calls = highlight.mock.calls.length;
    project.buildRust.mockClear();
    project.resolveRustLock.mockClear();
    const result = await project.sync(options);
    expect(result.plan.hasChanges).toBe(false);
    expect(project.preflightToolchains).toHaveBeenCalledOnce();
    expect(project.buildRust).not.toHaveBeenCalled();
    expect(project.resolveRustLock).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(highlight).toHaveBeenCalledTimes(calls);
  });

  it('groups pages by directory, by a function, or for the whole site', async () => {
    const pages = {
      'content/docs/index.mdx': page('println!("root");', [], 'root'),
      'content/docs/guides/a.mdx': page('println!("a");', [], 'a'),
      'content/docs/guides/b.mdx': page('println!("b");', [], 'b'),
      'content/docs/ja/guides/a.mdx': page('println!("ja");', [], 'ja')
    };
    const ids = async (grouping) => {
      const project = await fixture({ grouping, pages });
      await project.sync();
      const state = await project.state();
      return Object.fromEntries(
        Object.entries(state.languages.rust.groups).map(([id, group]) => [id, [group.key, group.pages]])
      );
    };
    expect(await ids('directory')).toEqual({
      [rustGroupId('directory', '.')]: ['.', ['index.mdx']],
      [rustGroupId('directory', 'guides')]: ['guides', ['guides/a.mdx', 'guides/b.mdx']],
      [rustGroupId('directory', 'ja/guides')]: ['ja/guides', ['ja/guides/a.mdx']]
    });
    expect(await ids('site')).toEqual({
      [rustGroupId('site', 'site')]: ['site', ['guides/a.mdx', 'guides/b.mdx', 'index.mdx', 'ja/guides/a.mdx']]
    });
    expect(Object.values(await ids(({ path: pagePath }) => (pagePath.endsWith('a.mdx') ? 'a' : 'rest')))).toEqual(
      expect.arrayContaining([
        ['a', ['guides/a.mdx', 'ja/guides/a.mdx']],
        ['rest', ['guides/b.mdx', 'index.mdx']]
      ])
    );
  });

  it('switches groupings and keeps groups whose id, pages, and sources are unchanged', async () => {
    const project = await fixture({
      pages: {
        'content/docs/one/a.mdx': page('println!("a");', [], 'a'),
        'content/docs/two/b.mdx': page('println!("b");', [], 'b'),
        'content/docs/two/c.mdx': page('println!("c");', [], 'c')
      }
    });
    await project.sync();
    const pageModules = (await project.state()).rust.modules;
    const byPart = ({ path: pagePath }) => pagePath.split('/')[0];
    const partitioned = await project.sync({ rustOptions: { grouping: byPart } });
    expect(project.rebuilt(partitioned)).toEqual(['one/a.mdx', 'two/b.mdx', 'two/c.mdx']);
    const parts = (await project.state()).rust.modules;
    expect(parts.map((module) => module.id)).toEqual(
      [rustGroupId('custom', 'one'), rustGroupId('custom', 'two')].sort()
    );
    // A reloaded function that keeps the "one" key reuses that module.
    const split = ({ path: pagePath }) => (pagePath.startsWith('one/') ? 'one' : pagePath);
    const regrouped = await project.sync({ rustOptions: { grouping: split } });
    expect(project.rebuilt(regrouped)).toEqual(['two/b.mdx', 'two/c.mdx']);
    const one = parts.find((module) => module.id === rustGroupId('custom', 'one'));
    expect((await project.state()).rust.modules.find((module) => module.id === one.id)).toEqual(one);
    const back = await project.sync();
    expect(project.rebuilt(back)).toEqual(['one/a.mdx', 'two/b.mdx', 'two/c.mdx']);
    expect((await project.state()).rust.modules).toEqual(pageModules);
    const files = await readdir(project.paths.rustWasmPublicDir);
    expect(files.sort()).toEqual(
      pageModules.flatMap((module) => [module.glue, module.wasm].map((asset) => path.basename(asset.url))).sort()
    );
    expect((await readdir(path.join(project.paths.rustCellsDir, 'modules'))).sort()).toEqual(
      pageModules.map((module) => module.id).sort()
    );
  });

  it('invalidates exactly the groups using direct or transitive helper inputs', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    await project.put('crates/shared/src/lib.rs', 'pub fn shared() { /* changed */ }');
    const changed = await project.sync();
    expect(project.rebuilt(changed)).toEqual(['first.mdx']);
    expect(changed.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'helper-inputs-changed' });
    await project.put('crates/beta/src/lib.rs', 'pub fn beta() { /* changed */ }');
    expect(project.rebuilt(await project.sync())).toEqual(['second.mdx']);
  });

  it('ignores helper dev-dependency changes', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    project.resolveRustLock.mockClear();
    await project.put(
      'crates/beta/Cargo.toml',
      '[package]\nname = "beta"\nversion = "0.1.0"\n[dev-dependencies]\nnum = "0.4"\n'
    );
    await project.put(
      'crates/Cargo.lock',
      'version = 4\n\n[[package]]\nname = "beta"\nversion = "0.1.0"\ndependencies = ["num"]\n\n[[package]]\nname = "num"\nversion = "0.4.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n'
    );
    const result = await project.sync();
    expect(result.plan.rustGroups.map((group) => group.public)).toEqual(['keep', 'keep']);
    expect(project.resolveRustLock).not.toHaveBeenCalled();
  });

  it('re-resolves the workspace lock when a helper adds a dependency its lock does not pin', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    project.resolveRustLock.mockClear();
    await project.put(
      'crates/beta/Cargo.toml',
      '[package]\nname = "beta"\nversion = "0.1.0"\n[dependencies]\nnum = "0.4"\n'
    );
    const result = await project.sync();
    expect(project.resolveRustLock).toHaveBeenCalledTimes(1);
    expect(project.rebuilt(result)).toEqual(['first.mdx', 'second.mdx']);
  });

  it('treats a helper manifest edit as a change to every module through unified features', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    await project.put(
      'crates/beta/Cargo.toml',
      '[package]\nname = "beta"\nversion = "0.1.0"\n[features]\ndefault = ["fast"]\nfast = []\n'
    );
    const result = await project.sync();
    expect(project.rebuilt(result)).toEqual(['first.mdx', 'second.mdx']);
    expect(result.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'dependencies-changed' });
  });

  it('reports the helper manifest path and failed validation without publishing', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    const before = await project.state();
    await project.put('crates/Cargo.toml', '[workspace');
    const output = [];
    const events = createRuntimeEvents({ report: (event) => output.push(event) });
    await expect(project.sync({ events })).rejects.toThrow(/Unable to read Rust helper input .*Cargo\.toml/u);
    expect(output).toContainEqual(
      expect.objectContaining({ type: 'phase', phase: 'validation', language: 'rust', state: 'failure' })
    );
    expect(await project.state()).toEqual(before);
  });

  it('rejects transitive inputs outside cratesDir that change during compilation', async () => {
    const project = await fixture({ helpers: true });
    await project.put(
      'crates/Cargo.toml',
      '[workspace]\nmembers = ["alpha", "beta", "shared"]\n[workspace.dependencies]\nshared = { path = "../external-shared" }\n'
    );
    await project.put('external-shared/Cargo.toml', '[package]\nname = "shared"\nversion = "0.1.0"\n');
    await project.put('external-shared/src/lib.rs', 'pub fn shared() {}');
    await project.sync();
    const before = await project.state();
    const build = project.buildRust.getMockImplementation();
    project.buildRust.mockImplementationOnce(async (options) => {
      const result = await build(options);
      await project.put('external-shared/src/lib.rs', 'pub fn shared() { /* concurrent edit */ }');
      return result;
    });
    await expect(project.sync({ forceRustBuild: true })).rejects.toThrow(/first\.mdx.*helper inputs changed/u);
    expect(await project.state()).toEqual(before);
    await project.put('external-shared/src/lib.rs', 'pub fn shared() {}');
    expect((await project.sync()).plan.hasChanges).toBe(false);
  });

  it('fails strict runs without publishing and reports every failing page', async () => {
    const project = await fixture({
      pages: Object.fromEntries(
        ['a', 'b', 'c'].map((name) => [`content/docs/${name}.mdx`, page(`println!("${name}");`)])
      )
    });
    await project.sync();
    const before = await readFile(project.paths.runtimeOwnershipPath);
    const manifest = await readFile(project.paths.cellsJsonPath);
    for (const name of ['a', 'b', 'c']) await project.put(`content/docs/${name}.mdx`, page(`println!("${name}!");`));
    project.fail({ a__example: compileError('a__example'), b__example: compileError('b__example') });
    for (const mode of ['dev', 'build']) {
      const error = await project.sync({ mode }).catch((failure) => failure);
      expect(error.message).toContain('a.mdx');
      expect(error.message).toContain('b.mdx');
      expect(error.exitCode).toBe(101);
      expect(error.rustModules.flatMap((module) => module.pages).sort()).toEqual(['a.mdx', 'b.mdx']);
      expect(await readFile(project.paths.runtimeOwnershipPath)).toEqual(before);
      expect(await readFile(project.paths.cellsJsonPath)).toEqual(manifest);
    }
  });

  it('publishes successful groups in development and keeps the last working module of failing groups', async () => {
    const project = await fixture({
      pages: Object.fromEntries(
        ['a', 'b', 'c'].map((name) => [`content/docs/${name}.mdx`, page(`println!("${name}");`)])
      )
    });
    const tolerant = { tolerateRustModuleFailures: true, session: project.session };
    await project.sync(tolerant);
    const before = await project.manifest();
    const failingModule = before.rust.modules.find((module) => module.cells.includes('a__example'));
    await project.put('content/docs/a.mdx', `${page('broken();')}\n${page('println!("new");', [], 'added')}`);
    await project.put('content/docs/b.mdx', page('println!("b updated");'));
    project.fail({ a__example: compileError('a__example') });
    const result = await project.sync(tolerant);
    expect(result.rustBuildResult.ok).toBe(false);
    expect(result.rustBuildResult.error.message).toContain('a.mdx');
    const after = await project.manifest();
    expect(after.rust.modules.find((module) => module.id === failingModule.id)).toEqual(failingModule);
    expect(after.cells.find((cell) => cell.id === 'a__example')).toEqual(
      before.cells.find((cell) => cell.id === 'a__example')
    );
    expect(after.cells.some((cell) => cell.id === 'a__added')).toBe(false);
    expect(after.cells.find((cell) => cell.id === 'b__example').source).toBe('println!("b updated");');
    const diagnostics = JSON.parse(
      await readFile(path.join(project.paths.buildCacheDir, 'rust-dev-diagnostics.json'), 'utf8')
    );
    expect(diagnostics.failedBlocks.map((block) => block.id).sort()).toEqual(['a__added', 'a__example']);
    // Unrelated edits replay the remembered failure instead of recompiling the group.
    project.buildRust.mockClear();
    await project.put('content/docs/c.mdx', page('println!("c updated");'));
    const replayed = await project.sync(tolerant);
    expect(project.buildRust.mock.calls[0][0].groups.map((group) => group.pages)).toEqual([['c.mdx']]);
    expect(replayed.rustBuildResult.ok).toBe(false);
    expect((await project.manifest()).rust.modules.find((module) => module.id === failingModule.id)).toEqual(
      failingModule
    );
    project.fail({});
    await project.put('content/docs/a.mdx', page('println!("fixed");'));
    const fixed = await project.sync(tolerant);
    expect(fixed.rustBuildResult).toBeUndefined();
    expect((await project.manifest()).cells.find((cell) => cell.id === 'a__example').source).toBe('println!("fixed");');
  });

  it('compiles a cell with an unterminated literal so that only its module fails', async () => {
    const project = await fixture({
      pages: Object.fromEntries(['a', 'b'].map((name) => [`content/docs/${name}.mdx`, page(`println!("${name}");`)]))
    });
    const tolerant = { tolerateRustModuleFailures: true, session: project.session };
    await project.sync(tolerant);
    await project.put('content/docs/a.mdx', page('let text = "unfinished;'));
    await project.put('content/docs/b.mdx', page('println!("b updated");'));
    // The mocked compiler stands in for rustc rejecting the unterminated literal.
    project.fail({ a__example: compileError('a__example') });
    const result = await project.sync(tolerant);
    expect(result.rustBuildResult.ok).toBe(false);
    expect(project.buildRust.mock.lastCall[0].groups.flatMap((group) => group.pages).sort()).toEqual([
      'a.mdx',
      'b.mdx'
    ]);
    expect((await project.manifest()).cells.find((cell) => cell.id === 'b__example').source).toBe(
      'println!("b updated");'
    );
  });

  it('does not keep a failing module whose published files were deleted', async () => {
    const project = await fixture({
      pages: Object.fromEntries(['a', 'b'].map((name) => [`content/docs/${name}.mdx`, page(`println!("${name}");`)]))
    });
    const tolerant = { tolerateRustModuleFailures: true, session: project.session };
    await project.sync(tolerant);
    const failingModule = (await project.manifest()).rust.modules.find((module) => module.cells.includes('a__example'));
    await rm(project.paths.rustWasmPublicDir, { recursive: true, force: true });
    await project.put('content/docs/a.mdx', page('broken();'));
    project.fail({ a__example: compileError('a__example') });
    const result = await project.sync(tolerant);
    expect(result.rustBuildResult.ok).toBe(false);
    const after = await project.manifest();
    expect(after.rust.modules.some((module) => module.id === failingModule.id)).toBe(false);
    expect(after.cells.some((cell) => cell.id === 'a__example')).toBe(false);
    const published = await readdir(project.paths.rustWasmPublicDir);
    for (const module of after.rust.modules)
      for (const asset of [module.glue, module.wasm]) expect(published).toContain(path.basename(asset.url));
  });

  it('prunes moved and deleted page outputs only after successful publication', async () => {
    const project = await fixture();
    await project.sync();
    const before = await project.state();
    await rename(path.join(project.paths.docsDir, 'first.mdx'), path.join(project.paths.docsDir, 'moved.mdx'));
    const moved = await project.sync();
    expect(moved.plan.removedRustGroups).toHaveLength(1);
    const obsolete = before.rust.modules.find((module) => module.id === moved.plan.removedRustGroups[0]);
    expect(defaultFileSystem.existsSync(path.join(project.paths.publicDir, obsolete.wasm.url))).toBe(false);
    expect(defaultFileSystem.existsSync(path.join(project.paths.rustCellsDir, 'modules', obsolete.id))).toBe(false);
    await rm(path.join(project.paths.docsDir, 'moved.mdx'));
    await project.sync();
    expect((await project.state()).rust.modules).toHaveLength(1);
    await rm(path.join(project.paths.docsDir, 'second.mdx'));
    await project.sync();
    expect((await project.state()).languages.rust).toBeUndefined();
  });

  it('rebuilds missing and corrupt assets, upgrades modes and honors forced builds', async () => {
    const project = await fixture();
    await project.sync();
    let state = await project.state();
    await writeFile(path.join(project.paths.publicDir, state.rust.modules[0].wasm.url), 'corrupt');
    let result = await project.sync();
    expect(result.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'integrity-mismatch' });
    state = await project.state();
    await rm(path.join(project.paths.publicDir, state.rust.modules[0].wasm.url));
    result = await project.sync();
    expect(result.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'integrity-mismatch' });
    result = await project.sync({ mode: 'build' });
    expect(
      result.plan.rustGroups.every((group) => group.reasons.public.some((reason) => reason.code === 'mode-upgrade'))
    ).toBe(true);
    expect(
      (await project.sync({ forceRustBuild: true })).plan.rustGroups.every((group) => group.public === 'build')
    ).toBe(true);
  });

  it('keeps outputs deterministic across clean builds', async () => {
    const project = await fixture();
    await project.sync({ mode: 'build' });
    const first = (await project.state()).rust;
    await rm(project.paths.cacheDir, { recursive: true, force: true });
    await rm(project.paths.rustWasmPublicDir, { recursive: true, force: true });
    await project.sync({ mode: 'build' });
    expect((await project.state()).rust).toEqual(first);
  });

  it('upgrades single-crate and page-directory layouts without a clean', async () => {
    const project = await fixture();
    await project.sync();
    const ownership = await project.state();
    const legacyFiles = ['site-0000.js', 'doc_rust_cells.js', 'LICENSE-MIT', 'package.json'];
    for (const file of legacyFiles)
      await project.put(path.relative(project.root, path.join(project.paths.rustWasmPublicDir, file)), 'legacy');
    await project.put(path.relative(project.root, path.join(project.paths.rustCellsDir, 'src/lib.rs')), 'legacy');
    await project.put(
      path.relative(project.root, path.join(project.paths.rustCellsDir, 'pages/page-1/src/lib.rs')),
      'x'
    );
    await project.put(
      path.relative(project.root, path.join(project.paths.buildCacheDir, 'rust-source-maps.json')),
      '{}'
    );
    ownership.languages.rust = { sourceFingerprint: 'site', publicFiles: legacyFiles, groups: { site: {} } };
    await writeFile(project.paths.runtimeOwnershipPath, JSON.stringify(ownership));
    const result = await project.sync();
    expect(project.rebuilt(result)).toEqual(['first.mdx', 'second.mdx']);
    for (const file of ['doc_rust_cells.js', 'LICENSE-MIT', 'package.json'])
      expect(defaultFileSystem.existsSync(path.join(project.paths.rustWasmPublicDir, file))).toBe(false);
    for (const directory of ['src', 'pages'])
      expect(defaultFileSystem.existsSync(path.join(project.paths.rustCellsDir, directory))).toBe(false);
    expect(defaultFileSystem.existsSync(path.join(project.paths.buildCacheDir, 'rust-source-maps.json'))).toBe(false);
    expect((await project.state()).languages.rust.layout).toBe(2);
  });

  it('explain uses no filesystem mutations or non-version subprocesses', async () => {
    const project = await fixture();
    const mutations = Object.fromEntries(
      ['mkdir', 'writeFile', 'copyFile', 'rename', 'rm', 'open', 'link', 'utimes'].map((name) => [
        name,
        vi.fn(() => {
          throw new Error(`unexpected ${name}`);
        })
      ])
    );
    const calls = [];
    const output = [];
    const events = createRuntimeEvents({ report: (event) => output.push(event) });
    const runCommand = vi.fn(async (command, args) => {
      calls.push([command, args]);
      expect(args).toEqual(['--version']);
      return (
        { rustc: 'rustc 1.99.0', cargo: 'cargo 1.99.0', 'wasm-bindgen': 'wasm-bindgen 0.2.129' }[
          path.basename(command)
        ] ?? 'wasm-opt version 117'
      );
    });
    const { preflightRequiredToolchains } =
      await import('../../packages/oxiquill/src/generator/doc-runtime/toolchain-preflight.mjs');
    const result = await project.sync({
      explain: true,
      fileSystem: { ...defaultFileSystem, ...mutations },
      runCommand,
      events,
      preflightToolchains: preflightRequiredToolchains
    });
    expect(result.plan.rustGroups).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(0);
    Object.values(mutations).forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
    expect(project.buildRust).not.toHaveBeenCalled();
    expect(project.resolveRustLock).not.toHaveBeenCalled();
    const planned = output.filter((event) => event.type === 'plan' && event.module);
    expect(planned).toHaveLength(4);
    expect(planned[0]).toMatchObject({ key: expect.any(String), pages: [expect.stringMatching(/\.mdx$/u)] });
  });
});

describe('definitions compilation invalidation', () => {
  const definitionsPage = (value = 7, unused = 'unused') =>
    `---\ntitle: Definitions\n---\n\n\`\`\`rust\n//| id: model\n//| kind: definitions\n//| crates: [alpha]\npub(crate) fn value() -> i32 { ${value} }\n\`\`\`\n\n\`\`\`rust\n//| id: unused\n//| kind: definitions\n//| crates: [beta]\ncompile_error!("${unused}");\n\`\`\`\n\n\`\`\`rust\n//| id: consumer\n//| uses: [model]\nprintln!("{}", value());\n\`\`\`\n`;
  it.each(['site', 'directory', 'page'])(
    'rebuilds used closures and ignores unused blocks with %s grouping',
    async (grouping) => {
      const project = await fixture({ grouping, helpers: true });
      await project.put('content/docs/second.mdx', page('println!("unrelated");'));
      await project.put('content/docs/first.mdx', definitionsPage());
      await project.sync();
      const before = await project.state();
      const changed = await project.sync();
      expect(changed.plan.languages.rust.public).toBe('keep');
      await project.put('content/docs/first.mdx', definitionsPage(7, 'edited unused'));
      expect((await project.sync()).plan.languages.rust.public).toBe('keep');
      await project.put('crates/beta/src/lib.rs', 'compile_error!("unused helper");');
      expect((await project.sync()).plan.languages.rust.public).toBe('keep');
      await project.put('content/docs/first.mdx', definitionsPage(9));
      const used = await project.sync();
      expect(used.plan.languages.rust.public).toBe('build');
      if (grouping === 'page') {
        expect(project.rebuilt(used)).toEqual(['first.mdx']);
        const unrelated = before.rust.modules.find((module) => module.cells.includes('second__example'));
        expect((await project.state()).rust.modules.find((module) => module.id === unrelated.id)).toEqual(unrelated);
      }
      const manifest = await project.manifest();
      expect(manifest.definitions).toHaveLength(2);
      expect(manifest.rust.modules.flatMap((module) => module.cells)).not.toContain('first__model');
      expect(JSON.stringify(manifest)).not.toContain('sourcePosition');
      expect(JSON.stringify(manifest)).not.toContain('regions');
      // A prose shift rewrites only the group's source map; the module is kept.
      await project.put('content/docs/first.mdx', '\n\n' + definitionsPage(9));
      expect((await project.sync()).plan.languages.rust.public).toBe('keep');
      const group = (await project.state()).rust.modules.find((module) => module.cells.includes('first__consumer'));
      const map = JSON.parse(
        await readFile(path.join(project.paths.rustCellsDir, 'modules', group.id, 'source-map.json'), 'utf8')
      );
      expect(map.regions.find((region) => region.cellId === 'first__model' && region.kind === 'authored').line).toBe(
        11
      );
    }
  );
});
