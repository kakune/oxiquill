import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { preparePageGroupingFixture } from './page-grouping-fixture.mjs';
import { createCellTestPlan } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-test-plan.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { testGeneratedRustCells } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-runtime-test.mjs';

const cwd = await preparePageGroupingFixture();
const sourcePath = path.join(cwd, 'content/docs/first.mdx');
const original = await readFile(sourcePath, 'utf8');
const helperPath = path.join(cwd, 'crates/page-math-base/src/lib.rs');
const originalHelper = await readFile(helperPath, 'utf8');
const previousGrouping = process.env.OXIQUILL_FIXTURE_GROUPING;
const invoke = async (args) => {
  const events = [];
  const started = performance.now();
  await runCli(args, { cwd, log: (line) => events.push(JSON.parse(line)) });
  assert.equal(events.at(-1).type, 'summary');
  assert.equal(events.at(-1).exitStatus, 0);
  return {
    elapsedMs: Math.round(performance.now() - started),
    phases: events.at(-1).phases,
    rebuiltModules: events
      .filter((event) => event.type === 'plan' && event.module && event.target === 'public' && event.action === 'build')
      .map((event) => event.module)
  };
};
const state = async () =>
  JSON.parse(await readFile(path.join(cwd, '.oxiquill/generated/runtime-ownership.json'), 'utf8'));
const sizes = async (registry) => {
  const modules = await Promise.all(
    registry.modules.map(async (module) => ({
      id: module.id,
      cells: module.cells,
      bytes: (
        await Promise.all(
          [module.glue, module.wasm].map(async (asset) => (await readFile(path.join(cwd, 'public', asset.url))).length)
        )
      ).reduce((a, b) => a + b, 0)
    }))
  );
  return {
    totalBytes: modules.reduce((total, module) => total + module.bytes, 0),
    pageBytes: Object.fromEntries(
      ['first', 'second', 'third'].map((page) => [
        page,
        modules
          .filter((module) => module.cells.some((id) => id.startsWith(`${page}__`)))
          .reduce((total, module) => total + module.bytes, 0)
      ])
    )
  };
};

try {
  process.env.OXIQUILL_FIXTURE_GROUPING = 'page';
  await runCli(['clean'], { cwd });
  await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
  const before = await state();
  assert.equal(before.rust.modules.length, 3);
  await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
  assert.deepEqual((await state()).rust, before.rust);
  const testLines = [];
  await runCli(['test-wasm', '--format', 'json'], { cwd, log: (line) => testLines.push(JSON.parse(line)) });
  assert.equal(testLines.at(-1).failed, 0);
  assert.equal(testLines.at(-1).total, 6);

  await writeFile(helperPath, originalHelper.replace('value * value', 'value * value + 1'));
  const helperChange = await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
  const firstModule = before.rust.modules.find((module) => module.cells.includes('first__compute'));
  assert.deepEqual(helperChange.rebuiltModules, [firstModule.id]);
  const helperState = await state();
  for (const module of before.rust.modules.filter((entry) => entry.id !== firstModule.id)) {
    assert.deepEqual(
      helperState.rust.modules.find((entry) => entry.id === module.id),
      module
    );
    assert.deepEqual(helperState.languages.rust.groups[module.id], before.languages.rust.groups[module.id]);
  }
  await writeFile(helperPath, originalHelper);
  await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);

  const paths = createOxiquillPaths({ workspaceRoot: cwd });
  const previousManifest = await readFile(paths.cellsJsonPath);
  await writeFile(sourcePath, original.replace('let result:', 'compile_error!("page failure fixture");\nlet result:'));
  const failedEvents = [];
  await assert.rejects(
    runCli(['docgen', '--wasm', 'dev', '--format', 'json'], {
      cwd,
      log: (line) => failedEvents.push(JSON.parse(line))
    }),
    (error) => error.exitCode === 101
  );
  assert.equal(failedEvents.at(-1).exitStatus, 101);
  assert.deepEqual(await readFile(paths.cellsJsonPath), previousManifest);
  const manifest = JSON.parse(previousManifest.toString('utf8'));
  const smokePlan = createCellTestPlan(manifest.cells, {}, paths);
  assert.equal((await testGeneratedRustCells({ tests: smokePlan.tests, paths, report: () => {} })).failed, 0);
  await writeFile(sourcePath, original);
  await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
  if (!process.argv.includes('--benchmark')) {
    const registry = (await state()).rust;
    await runCli(['clean'], { cwd });
    await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
    assert.deepEqual((await state()).rust, registry);
  }

  if (process.argv.includes('--benchmark')) {
    const measurements = [];
    for (const grouping of ['site', 'page']) {
      process.env.OXIQUILL_FIXTURE_GROUPING = grouping;
      await runCli(['clean'], { cwd });
      const clean = await invoke(['build', '--format', 'json']);
      const built = await state();
      const bytes = await sizes(built.rust);
      await writeFile(sourcePath, original.replace('.sum();', '.sum::<i32>() + 1;'));
      const incremental = await invoke(['build', '--format', 'json']);
      if (grouping === 'page') {
        const next = await state();
        for (const module of built.rust.modules.filter(
          (entry) => !entry.cells.some((id) => id.startsWith('first__'))
        )) {
          assert.deepEqual(
            next.rust.modules.find((entry) => entry.id === module.id),
            module
          );
          assert.deepEqual(next.languages.rust.groups[module.id], built.languages.rust.groups[module.id]);
        }
      }
      measurements.push({ grouping, clean, incremental, ...bytes });
      await writeFile(sourcePath, original);
      await runCli(['clean'], { cwd });
      await invoke(['build', '--format', 'json']);
      assert.deepEqual((await state()).rust, built.rust, `${grouping} output changed across clean builds`);
    }
    console.log(
      JSON.stringify(
        {
          cacheConditions:
            'Clean generated/compiler/optimizer caches per mode; verified downloads and Cargo registry caches retained. Full CLI build includes Astro check/build.',
          measurements
        },
        null,
        2
      )
    );
  } else
    console.log(
      'Page-grouped Rust compilation, transitive invalidation, rollback, clean determinism, and six cell executions passed.'
    );
} finally {
  await writeFile(sourcePath, original);
  await writeFile(helperPath, originalHelper);
  if (previousGrouping === undefined) delete process.env.OXIQUILL_FIXTURE_GROUPING;
  else process.env.OXIQUILL_FIXTURE_GROUPING = previousGrouping;
}
