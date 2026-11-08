import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { preparePageGroupingFixture } from './page-grouping-fixture.mjs';
import { createCellTestPlan } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-test-plan.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { testGeneratedRustCells } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-runtime-test.mjs';
import {
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { benchmarkTable, runLargeBookBenchmark } from './large-book-benchmark.mjs';

const cwd = await preparePageGroupingFixture();
const sourcePath = path.join(cwd, 'content/docs/first.mdx');
const original = await readFile(sourcePath, 'utf8');
const helperPath = path.join(cwd, 'crates/page-math-base/src/lib.rs');
const originalHelper = await readFile(helperPath, 'utf8');
const secondPath = path.join(cwd, 'content/docs/second.mdx');
const originalSecond = await readFile(secondPath, 'utf8');
const previousGrouping = process.env.OXIQUILL_FIXTURE_GROUPING;
const previousJobs = process.env.CARGO_BUILD_JOBS;
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

  // The development watcher publishes every other module and keeps the failing
  // page on its last working module.
  await writeFile(secondPath, originalSecond.replace('second ready', 'second updated'));
  const context = await createDocRuntimeContext({ paths, rustOptions: { grouping: 'page' } });
  const tolerated = await syncDocRuntime({ ...context, mode: 'dev', tolerateRustModuleFailures: true });
  assert.equal(tolerated.rustBuildResult.ok, false);
  assert.match(tolerated.rustBuildResult.error.message, /first\.mdx/u);
  const partial = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
  assert.deepEqual(
    partial.rust.modules.find((module) => module.id === firstModule.id),
    manifest.rust.modules.find((module) => module.id === firstModule.id)
  );
  assert.match(partial.cells.find((entry) => entry.id === 'second__text').source, /second updated/u);
  const partialPlan = createCellTestPlan(partial.cells, {}, paths);
  assert.equal((await testGeneratedRustCells({ tests: partialPlan.tests, paths, report: () => {} })).failed, 0);
  await writeFile(secondPath, originalSecond);
  await writeFile(sourcePath, original);
  await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
  if (!process.argv.includes('--benchmark')) {
    const registry = (await state()).rust;
    await runCli(['clean'], { cwd });
    await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
    assert.deepEqual((await state()).rust, registry);

    for (const [grouping, modules] of [
      ['directory', 1],
      ['site', 1],
      ['custom', 3]
    ]) {
      process.env.OXIQUILL_FIXTURE_GROUPING = grouping;
      await invoke(['docgen', '--wasm', 'dev', '--format', 'json']);
      const grouped = await state();
      assert.equal(grouped.rust.modules.length, modules, grouping);
      assert.ok(grouped.rust.modules.every((module) => module.id.startsWith(`${grouping}-`)));
      const lines = [];
      await runCli(['test-wasm', '--format', 'json'], { cwd, log: (line) => lines.push(JSON.parse(line)) });
      assert.equal(lines.at(-1).failed, 0, grouping);
    }

    // Release output is byte-identical across clean builds and post-link pool sizes.
    process.env.OXIQUILL_FIXTURE_GROUPING = 'page';
    const releases = [];
    for (const jobs of [undefined, '1']) {
      if (jobs === undefined) delete process.env.CARGO_BUILD_JOBS;
      else process.env.CARGO_BUILD_JOBS = jobs;
      await runCli(['clean'], { cwd });
      await invoke(['docgen', '--wasm', 'build', '--format', 'json']);
      releases.push((await state()).rust);
    }
    assert.deepEqual(releases[1], releases[0]);
  }

  if (process.argv.includes('--benchmark')) {
    const result = await runLargeBookBenchmark();
    console.log(JSON.stringify(result, null, 2));
    console.log(benchmarkTable(result));
  } else
    console.log(
      'Rust module groups, transitive invalidation, partial development publication, rollback, every grouping mode, and clean determinism across pool sizes passed.'
    );
} finally {
  await writeFile(sourcePath, original);
  await writeFile(helperPath, originalHelper);
  await writeFile(secondPath, originalSecond);
  if (previousJobs === undefined) delete process.env.CARGO_BUILD_JOBS;
  else process.env.CARGO_BUILD_JOBS = previousJobs;
  if (previousGrouping === undefined) delete process.env.OXIQUILL_FIXTURE_GROUPING;
  else process.env.OXIQUILL_FIXTURE_GROUPING = previousGrouping;
}
