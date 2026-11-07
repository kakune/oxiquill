// @vitest-environment node
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocRuntimeContext, syncDocRuntime } from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { defaultFileSystem } from '../../packages/oxiquill/src/generator/doc-runtime/file-system.mjs';
import {
  createRustGroups,
  lockDependencyClosure
} from '../../packages/oxiquill/src/generator/doc-runtime/rust-groups.mjs';
import { normalizeRustOptions } from '../../packages/oxiquill/src/config/metadata.mjs';
import { applyRustGroupPlan } from '../../packages/oxiquill/src/generator/doc-runtime/rust-group-service.mjs';
import { createRuntimeEvents } from '../../packages/oxiquill/src/generator/doc-runtime/runtime-events.mjs';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function page(source, crates = []) {
  return `---\ntitle: Test\n---\n\n\`\`\`rust\n//| id: example\n//| crates: ${JSON.stringify(crates)}\n${source}\n\`\`\`\n`;
}

async function fixture({ helpers = false, grouping = 'page' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-group-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  const put = async (file, source) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  await put('content/docs/first.mdx', page('println!("first");', helpers ? ['alpha'] : []));
  await put('content/docs/second.mdx', page('println!("second");', helpers ? ['beta'] : []));
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
  const buildGroups = vi.fn(async ({ groups, paths: staged }) => {
    for (const group of groups.filter((entry) => entry.public === 'build')) {
      const directory = path.join(staged.rustWasmPublicDir, group.id);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'doc_rust_cells.js'), 'const wasm = "doc_rust_cells_bg.wasm";');
      await writeFile(path.join(directory, 'doc_rust_cells_bg.wasm'), group.desired.buildFingerprint);
    }
  });
  const buildRust = vi.fn(async ({ paths: staged }) => {
    await writeFile(path.join(staged.rustWasmPublicDir, 'doc_rust_cells.js'), 'const wasm = "doc_rust_cells_bg.wasm";');
    await writeFile(
      path.join(staged.rustWasmPublicDir, 'doc_rust_cells_bg.wasm'),
      await readFile(path.join(staged.rustCellsDir, 'src/lib.rs'))
    );
  });
  const context = () =>
    createDocRuntimeContext({
      paths,
      rustOptions: { grouping },
      highlighter: { codeToHtml: async (source) => `<pre>${source}</pre>` }
    });
  const sync = async (options = {}) =>
    syncDocRuntime({
      ...(await context()),
      buildGroups,
      buildRust,
      generatorIdentity: async () => 'fixture-generator',
      preflightToolchains: async () => ({ rust: { version: 'test' } }),
      syncLicenses: async () => false,
      environment: {},
      mode: 'dev',
      ...options
    });
  const state = async () => JSON.parse(await readFile(paths.runtimeOwnershipPath, 'utf8'));
  return { root, paths, put, sync, state, buildGroups, buildRust, context };
}

describe('page-grouped Rust runtime', () => {
  it('validates grouping and defaults to site', () => {
    expect(normalizeRustOptions()).toEqual({ grouping: 'site' });
    expect(normalizeRustOptions({ grouping: 'page' })).toEqual({ grouping: 'page' });
    expect(() => normalizeRustOptions({ grouping: 'directory' })).toThrow('site, page');
    expect(() => normalizeRustOptions({ grouping: null })).toThrow('site, page');
    expect(() => normalizeRustOptions(null)).toThrow('object');
    expect(() => normalizeRustOptions({ unknown: true })).toThrow('Unknown rust option');
  });

  it.each(['../../outside', '', 'site'])('rejects untrusted saved group ID %j before cleanup', (id) => {
    expect(() => applyRustGroupPlan({}, { groups: [] }, { languages: { rust: { groups: { [id]: {} } } } })).toThrow(
      'Invalid Rust group state id'
    );
  });

  it('uses docs-relative IDs independent of traversal order and checkout location', async () => {
    const project = await fixture();
    const context = await project.context();
    const cells = [
      {
        id: 'first__a',
        pagePath: 'content/docs/first.mdx',
        language: 'rust',
        source: 'println!("a");',
        crates: [],
        inputs: []
      },
      {
        id: 'second__b',
        pagePath: 'content/docs/second.mdx',
        language: 'rust',
        source: 'println!("b");',
        crates: [],
        inputs: []
      }
    ];
    const first = createRustGroups({ ...context, cells });
    const second = createRustGroups({
      ...context,
      cells: cells.toReversed(),
      paths: createOxiquillPaths({ workspaceRoot: '/different/checkout', docsDir: 'content/docs' })
    });
    expect(first.map(({ id, packageName, page: pagePath }) => ({ id, packageName, pagePath }))).toEqual(
      second.map(({ id, packageName, page: pagePath }) => ({ id, packageName, pagePath }))
    );
    expect(first[0].id).toMatch(/^page-[a-f0-9]{64}$/u);
    expect(first[0].cargo).not.toContain('[workspace]');
  });

  it('reuses source-only generation and subsequently builds its missing modules', async () => {
    const project = await fixture();
    await project.sync({ mode: undefined });
    expect(project.buildGroups).not.toHaveBeenCalled();
    expect((await project.sync({ mode: undefined })).plan.hasChanges).toBe(false);
    const built = await project.sync();
    expect(built.plan.rustGroups.every((group) => group.source === 'keep' && group.public === 'build')).toBe(true);
    expect((await project.state()).rust.modules).toHaveLength(2);
  });

  it('rebuilds only the edited page and preserves another module bytes and fingerprints', async () => {
    const project = await fixture();
    await project.sync();
    const before = await project.state();
    const unchanged = before.rust.modules.find((module) => module.cells.some((id) => id.includes('second')));
    const bytes = await readFile(path.join(project.paths.publicDir, unchanged.wasm.url));
    project.buildGroups.mockClear();
    await project.put('content/docs/first.mdx', page('println!("edited");'));
    const result = await project.sync();
    expect(result.plan.rustGroups.filter((group) => group.public === 'build').map((group) => group.page)).toEqual([
      'first.mdx'
    ]);
    const after = await project.state();
    expect(after.rust.modules.find((module) => module.id === unchanged.id)).toEqual(unchanged);
    expect(after.languages.rust.groups[unchanged.id]).toEqual(before.languages.rust.groups[unchanged.id]);
    expect(await readFile(path.join(project.paths.publicDir, unchanged.wasm.url))).toEqual(bytes);
    project.buildGroups.mockClear();
    const kept = await project.sync();
    expect(project.buildGroups).not.toHaveBeenCalled();
    expect(kept.plan.hasChanges).toBe(false);
  });

  it('invalidates exactly the groups using direct or transitive helper inputs', async () => {
    const project = await fixture({ helpers: true });
    await project.sync();
    await project.put('crates/shared/src/lib.rs', 'pub fn shared() { /* changed */ }');
    const changed = await project.sync();
    expect(changed.plan.rustGroups.filter((group) => group.public === 'build').map((group) => group.page)).toEqual([
      'first.mdx'
    ]);
    expect(changed.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'helper-inputs-changed' });
    await project.put('crates/beta/src/lib.rs', 'pub fn beta() { /* changed */ }');
    expect(
      (await project.sync()).plan.rustGroups.filter((group) => group.public === 'build').map((group) => group.page)
    ).toEqual(['second.mdx']);
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
    const build = project.buildGroups.getMockImplementation();
    project.buildGroups.mockImplementationOnce(async (options) => {
      await build(options);
      await project.put('external-shared/src/lib.rs', 'pub fn shared() { /* concurrent edit */ }');
    });
    await expect(project.sync({ forceRustBuild: true })).rejects.toThrow(/first\.mdx.*helper inputs changed/u);
    expect(await project.state()).toEqual(before);
    await project.put('external-shared/src/lib.rs', 'pub fn shared() {}');
    expect((await project.sync()).plan.hasChanges).toBe(false);
  });

  it('publishes nothing when a group fails and retries against the previous complete registry', async () => {
    const project = await fixture();
    await project.sync();
    const before = await readFile(project.paths.runtimeOwnershipPath);
    const manifest = await readFile(project.paths.cellsJsonPath);
    await project.put('content/docs/first.mdx', page('invalid rust'));
    project.buildGroups.mockRejectedValueOnce(new Error('group failed'));
    await expect(project.sync()).rejects.toThrow('group failed');
    expect(await readFile(project.paths.runtimeOwnershipPath)).toEqual(before);
    expect(await readFile(project.paths.cellsJsonPath)).toEqual(manifest);
    await project.put('content/docs/first.mdx', page('println!("first");'));
    const retried = await project.sync();
    expect(retried.plan.rustGroups[0].source).toBe('write');
    expect(retried.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'previous-build-failed' });
    expect(await readFile(project.paths.cellsJsonPath)).toEqual(manifest);
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
    expect(result.plan.rustGroups[0].reasons.public).toContainEqual({ code: 'output-missing' });
    result = await project.sync({ mode: 'build' });
    expect(
      result.plan.rustGroups.every((group) => group.reasons.public.some((reason) => reason.code === 'mode-upgrade'))
    ).toBe(true);
    expect(
      (await project.sync({ forceRustBuild: true })).plan.rustGroups.every((group) => group.public === 'build')
    ).toBe(true);
  });

  it('keeps outputs deterministic across clean source builds and switches both grouping modes', async () => {
    const project = await fixture();
    await project.sync();
    const first = (await project.state()).rust;
    await rm(project.paths.cacheDir, { recursive: true, force: true });
    await rm(project.paths.rustWasmPublicDir, { recursive: true, force: true });
    await project.sync();
    expect((await project.state()).rust).toEqual(first);
    await project.sync({ rustOptions: { grouping: 'site' } });
    expect((await project.state()).rust.modules.map((module) => module.id)).toEqual(['site']);
    await project.sync();
    expect((await project.state()).rust.modules.map((module) => module.id)).toEqual(
      first.modules.map((module) => module.id)
    );
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
    expect(project.buildGroups).not.toHaveBeenCalled();
    expect(output.filter((event) => event.type === 'plan' && event.module)).toHaveLength(4);
  });

  it('selects only the requested lock dependency closure', () => {
    const packages = [
      { name: 'root', version: '1', dependencies: ['renamed 2'] },
      { name: 'renamed', version: '2', dependencies: ['leaf'] },
      { name: 'leaf', version: '1' },
      { name: 'unused', version: '1' }
    ];
    expect(lockDependencyClosure(packages, ['root']).map((entry) => entry.name)).toEqual(['leaf', 'renamed', 'root']);
  });
});

describe('definitions compilation invalidation', () => {
  const definitionsPage = (value = 7, unused = 'unused') =>
    `---\ntitle: Definitions\n---\n\n\`\`\`rust\n//| id: model\n//| kind: definitions\n//| crates: [alpha]\npub(crate) fn value() -> i32 { ${value} }\n\`\`\`\n\n\`\`\`rust\n//| id: unused\n//| kind: definitions\n//| crates: [beta]\ncompile_error!("${unused}");\n\`\`\`\n\n\`\`\`rust\n//| id: consumer\n//| uses: [model]\nprintln!("{}", value());\n\`\`\`\n`;
  it.each(['site', 'page'])('rebuilds used closures and ignores unused blocks with %s grouping', async (grouping) => {
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
      expect(used.plan.rustGroups.filter((group) => group.public === 'build').map((group) => group.page)).toEqual([
        'first.mdx'
      ]);
      const unrelated = before.rust.modules.find((module) => module.cells.includes('second__example'));
      expect((await project.state()).rust.modules.find((module) => module.id === unrelated.id)).toEqual(unrelated);
    }
    const manifest = JSON.parse(await readFile(project.paths.cellsJsonPath, 'utf8'));
    expect(manifest.definitions).toHaveLength(2);
    expect(manifest.rust.modules.flatMap((module) => module.cells)).not.toContain('first__model');
    expect(JSON.stringify(manifest)).not.toContain('sourcePosition');
    expect(JSON.stringify(manifest)).not.toContain('regions');
    await project.put('content/docs/first.mdx', '\n\n' + definitionsPage(9));
    expect((await project.sync()).plan.languages.rust.public).toBe('keep');
    const maps = JSON.parse(await readFile(path.join(project.paths.buildCacheDir, 'rust-source-maps.json')));
    expect(
      maps.files
        .flatMap((file) => file.regions)
        .find((region) => region.cellId === 'first__model' && region.kind === 'authored').line
    ).toBe(11);
  });
});
