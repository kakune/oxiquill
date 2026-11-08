import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { prepareLinkedFixture, pageGroupingRoot, writeFixtureProject } from './page-grouping-fixture.mjs';

const DIRECTORIES = 20;
const PAGES_PER_DIRECTORY = 10;
const CELLS_PER_PAGE = 10;

const cell = (directory, page, index) =>
  [
    '```rust',
    `//| id: c${index}`,
    `//| title: Cell ${index}`,
    '//| inputs:',
    `//|   n: { type: integer, label: Count, value: ${index + 2}, min: 1, max: 64 }`,
    `let values: Vec<f64> = (0..n).map(|i| (i as f64 + ${directory}.0) * ${page + 1}.0).collect();`,
    'let mean = values.iter().sum::<f64>() / values.len() as f64;',
    `println!("d${directory} p${page} c${index}: {mean:.3}");`,
    '```'
  ].join('\n');

// A synthetic book: 20 directories x 10 pages x 10 Rust cells.
async function createBook() {
  const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-large-book-'));
  await prepareLinkedFixture(root);
  await writeFixtureProject(root, { title: 'Large book' });
  await mkdir(path.join(root, 'content/docs'), { recursive: true });
  await writeFile(path.join(root, 'content/docs/index.mdx'), '---\ntitle: Large book\n---\n\nSynthetic chapters.\n');
  for (let directory = 0; directory < DIRECTORIES; directory += 1) {
    const chapter = path.join(root, 'content/docs', `chapter-${String(directory).padStart(2, '0')}`);
    await mkdir(chapter, { recursive: true });
    for (let page = 0; page < PAGES_PER_DIRECTORY; page += 1)
      await writeFile(
        path.join(chapter, `page-${page}.mdx`),
        [
          `---\ntitle: Chapter ${directory} page ${page}\n---`,
          ...Array.from({ length: CELLS_PER_PAGE }, (_, index) => cell(directory, page, index))
        ].join('\n\n')
      );
  }
  // Copy a verified tool download when one exists, so measurements exclude the network.
  await cp(path.join(pageGroupingRoot, '.cache'), path.join(root, '.cache'), { recursive: true }).catch(() => {});
  return root;
}

async function measure(cwd, args) {
  const events = [];
  const started = performance.now();
  await runCli([...args, '--format', 'json'], { cwd, log: (line) => events.push(JSON.parse(line)) });
  const summary = events.at(-1);
  assert.equal(summary.type, 'summary');
  assert.equal(summary.exitStatus, 0);
  return {
    ms: Math.round(performance.now() - started),
    phases: Object.fromEntries(summary.phases.map((phase) => [phase.phase, phase.elapsedMs])),
    rebuilt: new Set(
      events
        .filter(
          (event) => event.type === 'plan' && event.module && event.target === 'public' && event.action === 'build'
        )
        .map((event) => event.module)
    ).size
  };
}

async function sizes(cwd) {
  const manifest = JSON.parse(await readFile(path.join(cwd, '.oxiquill/generated/cells.json'), 'utf8'));
  const bytes = new Map(manifest.rust.modules.map((module) => [module.id, module.wasm.bytes]));
  const pages = new Map();
  for (const entry of manifest.cells) {
    const module = manifest.rust.modules.find((candidate) => candidate.cells.includes(entry.id));
    if (!pages.has(entry.pagePath)) pages.set(entry.pagePath, new Set());
    pages.get(entry.pagePath).add(module.id);
  }
  const perPage = [...pages.values()].map((ids) => [...ids].reduce((total, id) => total + bytes.get(id), 0));
  return {
    modules: manifest.rust.modules.length,
    totalWasmBytes: [...bytes.values()].reduce((total, value) => total + value, 0),
    perPageWasmBytes: { min: Math.min(...perPage), max: Math.max(...perPage) }
  };
}

export async function runLargeBookBenchmark({ groupings = ['site', 'directory', 'page'] } = {}) {
  const root = await createBook();
  const previous = process.env.OXIQUILL_FIXTURE_GROUPING;
  const edited = path.join(root, 'content/docs/chapter-07/page-3.mdx');
  const original = await readFile(edited, 'utf8');
  const measurements = [];
  try {
    for (const grouping of groupings) {
      process.env.OXIQUILL_FIXTURE_GROUPING = grouping;
      await runCli(['clean'], { cwd: root, log: () => {} });
      const devClean = await measure(root, ['docgen', '--wasm', 'dev']);
      const devNoop = await measure(root, ['docgen', '--wasm', 'dev']);
      await writeFile(edited, original.replace('println!("d7 p3 c4', 'println!("edited d7 p3 c4'));
      const devEdit = await measure(root, ['docgen', '--wasm', 'dev']);
      await writeFile(edited, original);
      await runCli(['clean'], { cwd: root, log: () => {} });
      const buildClean = await measure(root, ['docgen', '--wasm', 'build']);
      const buildNoop = await measure(root, ['docgen', '--wasm', 'build']);
      await writeFile(edited, original.replace('println!("d7 p3 c4', 'println!("edited d7 p3 c4'));
      const buildEdit = await measure(root, ['docgen', '--wasm', 'build']);
      await writeFile(edited, original);
      await measure(root, ['docgen', '--wasm', 'build']);
      measurements.push({
        grouping,
        devClean,
        devNoop,
        devEdit,
        buildClean,
        buildNoop,
        buildEdit,
        ...(await sizes(root))
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OXIQUILL_FIXTURE_GROUPING;
    else process.env.OXIQUILL_FIXTURE_GROUPING = previous;
    await writeFile(edited, original).catch(() => {});
    if (!process.argv.includes('--keep')) await rm(root, { recursive: true, force: true });
  }
  return {
    book: { directories: DIRECTORIES, pagesPerDirectory: PAGES_PER_DIRECTORY, cellsPerPage: CELLS_PER_PAGE },
    cacheConditions:
      'Runtime generation through `oxiquill docgen` after `oxiquill clean` per grouping and profile; verified downloads and the Cargo registry cache are retained. Times are wall-clock milliseconds.',
    measurements
  };
}

export function benchmarkTable({ measurements }) {
  const row = (label, pick) => `| ${label} | ${measurements.map((entry) => pick(entry)).join(' | ')} |`;
  const seconds = (value) => `${(value.ms / 1000).toFixed(1)} s`;
  return [
    `| | ${measurements.map((entry) => `\`${entry.grouping}\``).join(' | ')} |`,
    `|---|${measurements.map(() => '---').join('|')}|`,
    row('Modules', (entry) => entry.modules),
    row('Clean dev generation', (entry) => seconds(entry.devClean)),
    row('No-op dev sync', (entry) => seconds(entry.devNoop)),
    row('Single-page edit (dev)', (entry) => `${seconds(entry.devEdit)} (${entry.devEdit.rebuilt} rebuilt)`),
    row('Clean release generation', (entry) => seconds(entry.buildClean)),
    row('No-op release sync', (entry) => seconds(entry.buildNoop)),
    row('Single-page edit (release)', (entry) => `${seconds(entry.buildEdit)} (${entry.buildEdit.rebuilt} rebuilt)`),
    row('Total Wasm', (entry) => `${(entry.totalWasmBytes / 1024).toFixed(0)} KiB`),
    row(
      'Wasm per page (min-max)',
      (entry) =>
        `${(entry.perPageWasmBytes.min / 1024).toFixed(0)}-${(entry.perPageWasmBytes.max / 1024).toFixed(0)} KiB`
    )
  ].join('\n');
}
