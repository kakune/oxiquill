import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { verifyWasmOptCache } from './wasm-opt-cache-smoke.mjs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRustWasm,
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { listFiles } from '../../packages/oxiquill/dist/generator/doc-runtime/file-system.mjs';
import { wasmPackEnvironment } from '../../packages/oxiquill/dist/generator/doc-runtime/compiler-cache.mjs';
import { validateOutputArtifacts } from '../../packages/oxiquill/dist/lib/doc-runtime/output-artifact-validation.js';

const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-rust-codegen-'));
const paths = createOxiquillPaths({ workspaceRoot });

try {
  await cp(new URL('../fixtures/rust-codegen/', import.meta.url), workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await runCli(['test-wasm'], {
    cwd: workspaceRoot,
    loadProjectConfig: async () => ({ astroConfigArgs: [], cwd: workspaceRoot, paths })
  });
  const generatedSource = await readFile(path.join(paths.rustCellsDir, 'src/lib.rs'), 'utf8');
  assert.ok(!generatedSource.includes('wasm_bindgen_test'));
  assert.ok(!(await readFile(path.join(paths.rustCellsDir, 'Cargo.toml'), 'utf8')).includes('wasm-bindgen-test'));
  const configModule = new URL('../../packages/oxiquill/dist/astro/index.js', import.meta.url).href;
  await writeFile(
    path.join(workspaceRoot, 'astro.config.mjs'),
    `import { oxiquillIntegration } from ${JSON.stringify(configModule)};\nexport default { integrations: [oxiquillIntegration()] };\n`
  );
  const cliPath = new URL('../../packages/oxiquill/dist/cli/index.mjs', import.meta.url);
  const invoke = (args) =>
    spawnSync(process.execPath, [fileURLToPath(cliPath), 'test-wasm', '--format', 'json', ...args], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 120_000
    });
  const selected = invoke(['--page', './index.mdx', '--cell', 'declared-tests', '--case', 'named']);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  const selectedEvents = selected.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    selectedEvents.map((event) => event.type),
    ['test', 'summary']
  );
  assert.equal(selectedEvents[0].case, 'named');
  assert.equal(selectedEvents[0].status, 'pass');
  const unmatched = invoke(['--cell', 'missing']);
  assert.equal(unmatched.status, 1);
  assert.match(unmatched.stdout, /matched no cells/u);
  const timeout = invoke(['--page', 'index.mdx', '--cell', 'declared-tests', '--all-cases', '--case', 'timeout']);
  assert.equal(timeout.status, 1, timeout.stderr || timeout.stdout);
  const timeoutEvents = timeout.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(timeoutEvents[0].failures[0].reason, 'timeout');
  assert.equal(timeoutEvents.at(-1).exitStatus, 1);
  const pagePath = path.join(workspaceRoot, 'content/docs/index.mdx');
  const authored = await readFile(pagePath, 'utf8');
  for (const [assertion, reason] of [
    ['{ path: /outputs/0/value/n, equals: 999 }', 'not-equal'],
    ['{ path: /outputs/0/absent, equals: 1 }', 'missing-path'],
    ['{ artifact: absent, path: "", equals: 1 }', 'missing-artifact']
  ]) {
    await writeFile(pagePath, authored.replace('{ path: /outputs/0/value/n, equals: 1 }', assertion));
    const failed = invoke(['--page', 'index.mdx', '--cell', 'declared-tests', '--case', 'default']);
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
    const events = failed.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(events[0].failures[0].reason, reason);
    assert.ok(events[0].failures[0].location.line > 0);
    assert.equal(events.at(-1).type, 'summary');
    assert.equal(events.at(-1).failed, 1);
  }
  await writeFile(pagePath, authored);
  const rustAsset = async (kind) => {
    const manifest = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
    return path.join(paths.publicDir, decodeURIComponent(manifest.rust.modules[0][kind].url));
  };
  const runtime = await import(pathToFileURL(await rustAsset('glue')).href);
  runtime.initSync({ module: await readFile(await rustAsset('wasm')) });
  const manifest = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8')).cells;
  const run = (name, inputs = {}) => {
    const cell = manifest.find((entry) => entry.id.endsWith(`__${name}`));
    assert.ok(cell, `${name} fixture must be generated`);
    return JSON.parse(runtime.run_rust_cell(cell.id, JSON.stringify(inputs)));
  };
  assert.deepEqual(run('multiline-literals').outputs[0].value, {
    text: 'first\nsecond',
    raw: 'first\n  second',
    bytes: [...Buffer.from('first\nsecond')],
    raw_bytes: [...Buffer.from('first\n  second')]
  });
  const contract = JSON.parse(await readFile(new URL('../fixtures/output-contract.json', import.meta.url), 'utf8'));
  for (const fixture of contract.filter((fixture) => fixture.artifact.kind === 'chart')) {
    const { spec, ...metadata } = structuredClone(fixture.artifact);
    Reflect.deleteProperty(metadata, 'kind');
    if (fixture.pointCount) spec.series[0].points = Array.from({ length: fixture.pointCount }, () => [0, 1]);
    const outputs = run('generic-charts', {
      fixture: JSON.stringify(spec),
      metadata: JSON.stringify(metadata)
    }).outputs;
    const [actual] = validateOutputArtifacts([outputs[1]]);
    assert.equal(actual.status, fixture.expected.status, fixture.name);
    if (fixture.pointCount) {
      if (actual.status === 'valid') assert.equal(actual.artifact.spec.series[0].points.length, fixture.pointCount);
      else assert.equal(actual.message, fixture.expected.message);
    } else {
      assert.deepEqual(actual, fixture.expected, fixture.name);
    }
  }
  for (const spec of [
    { kind: 'boxplot', categories: [], series: [{ values: Array.from({ length: 100001 }, () => [0, 1, 2, 3, 4]) }] },
    { kind: 'bubble', series: [{ points: Array.from({ length: 100001 }, () => [0, 1, 2]) }] },
    { kind: 'field', xEdges: [0, 1], yEdges: [0, 1], values: [Array(100001).fill(0)] },
    { kind: 'field', xEdges: Array(100002).fill(0), yEdges: [], values: [] },
    { kind: 'line', series: [], annotations: Array(101).fill({}) }
  ]) {
    const output = run('generic-charts', { fixture: JSON.stringify(spec), metadata: '{}' }).outputs[0];
    assert.equal(output.kind, '__oxiquill_error', 'Producer must reject oversized charts before transfer');
  }
  const runMetadata = (metadata) =>
    validateOutputArtifacts([
      run('generic-charts', {
        fixture: JSON.stringify({ kind: 'line', series: [] }),
        metadata: JSON.stringify(metadata)
      }).outputs[1]
    ])[0];
  assert.deepEqual(runMetadata({ id: null, title: 'Title', caption: null }), {
    status: 'valid',
    artifact: { title: 'Title', kind: 'chart', spec: { kind: 'line', series: [] } },
    byteLength: runMetadata({ title: 'Title' }).byteLength,
    index: 0
  });
  assert.deepEqual(runMetadata({ titel: 'Title' }), {
    status: 'error',
    message: 'unsupported chart metadata field: titel',
    index: 0
  });
  const areas = run('area-overloads').outputs;
  assert.equal(areas.length, 5);
  assert.ok(areas.every((artifact) => artifact.spec.kind === 'area'));
  assert.equal(areas[2].spec.xLabel, 'Time');
  assert.equal(areas[3].spec.yLabel, 'Value');
  assert.equal(areas[4].spec.yMax, 3);
  for (const index of [1, 3, 4]) assert.deepEqual(areas[index].spec.style, { animation: false });
  const errors = validateOutputArtifacts(run('chart-errors', { count: 100001 }).outputs);
  assert.deepEqual(
    errors.map((result) => result.status),
    ['valid', 'error', 'error', 'error', 'valid']
  );
  assert.equal(run('density-histogram').outputs[0].spec.mode, 'density');
  const presentations = run('series-presentation').outputs;
  assert.equal(presentations[0].spec.series[0].id, 'a');
  assert.equal(presentations[0].spec.series[0].style.lineType, 'dashed');
  assert.deepEqual(presentations[1].spec.series[0].style.color, { dark: '#123' });
  const optionsCharts = run('chart-options').outputs;
  const linkedCharts = validateOutputArtifacts(run('linked-chart-options').outputs);
  assert.equal(linkedCharts.length, 3);
  for (const output of linkedCharts) {
    assert.equal(output.status, 'valid');
    assert.deepEqual(output.artifact.spec.link, { group: 'linked-macros', zoom: true, cursor: true });
  }
  assert.equal(optionsCharts.length, 4);
  for (const artifact of optionsCharts) {
    assert.equal(artifact.spec.yMin, 0);
    assert.equal(artifact.spec.yMax, 5);
    assert.deepEqual(artifact.spec.style, { animation: false });
  }
  assert.throws(
    () => run('invalid-chart-options', { invalid: true }),
    (error) => error === 'unsupported chart option: series'
  );
  assert.throws(
    () => run('nonobject-chart-options', { invalid: true }),
    (error) => error === 'chart options must serialize as an object'
  );
  const output = run('spaced-macros');
  const charts = run('chart-style-overloads').outputs;
  assert.equal(charts.length, 16);
  for (const [index, artifact] of charts.entries()) {
    assert.equal(artifact.kind, 'chart');
    assert.equal(
      artifact.spec.kind,
      index < 4
        ? 'line'
        : index < 8
          ? 'scatter'
          : index < 10
            ? 'bar'
            : index < 12
              ? 'histogram'
              : index < 14
                ? 'heatmap'
                : 'line'
    );
    if (index % 2 === 0) assert.equal(Object.hasOwn(artifact.spec, 'style'), false);
    else assert.deepEqual(artifact.spec.style, { animation: false, palette: { light: ['#123', '#456'] } });
  }
  assert.equal(output.outputs[0].content, 'spaced output\n');
  assert.deepEqual(output.outputs.find((artifact) => artifact.kind === 'json')?.value, { ok: true });
  assert.equal(
    output.outputs.find((artifact) => artifact.kind === 'image')?.data,
    '<svg xmlns="http://www.w3.org/2000/svg"/>'
  );

  const collision = run('colliding-locals');
  assert.equal(collision.outputs[0].content, 'author value:42\n\n');
  assert.deepEqual(collision.outputs, [
    { kind: 'text', stream: 'stdout', content: 'author value:42\n\n', truncated: false },
    { kind: 'json', value: { label: 'author value', number: 42 }, truncated: false }
  ]);
  const inputs = run('inputs-and-question-mark', { label: 'custom input', fail: false });
  assert.equal(inputs.outputs[0].content, 'custom input:42\n');
  assert.deepEqual(inputs.outputs.at(-1), {
    kind: 'text',
    stream: 'display',
    content: 'custom input:42',
    truncated: false
  });
  assert.throws(
    () => run('inputs-and-question-mark', { label: 'input', fail: true }),
    (error) => error === 'question mark failure'
  );
  assert.equal(run('early-return', { early: false }).outputs[0].content, 'normal return\n');
  assert.deepEqual(run('early-return', { early: true }), {
    outputs: [{ kind: 'text', stream: 'stdout', content: 'early return', truncated: false }]
  });
  const targetDir = path.resolve(workspaceRoot, wasmPackEnvironment({ paths }).CARGO_TARGET_DIR);
  const dependencyFiles = (await listFiles(targetDir)).filter(
    (file) =>
      /[/\\]deps[/\\]/u.test(file) && /\.(?:rlib|rmeta)$/u.test(file) && !path.basename(file).includes('doc_rust_cells')
  );
  assert.ok(dependencyFiles.length > 0, 'warm build must produce cached registry artifacts');
  const dependencyTimes = await Promise.all(dependencyFiles.map(async (file) => [file, (await stat(file)).mtimeMs]));
  await verifyWasmOptCache({ paths });
  let publishedWasm = await readFile(await rustAsset('wasm'));
  const publishedReady = await readFile(paths.runtimeVersionPath);
  const context = await createDocRuntimeContext({ paths });
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const attempt = syncDocRuntime({
    ...context,
    mode: 'build',
    forceRustBuild: true,
    buildRust: async (options) => {
      entered.resolve();
      await resume.promise;
      await buildRustWasm(options);
    }
  });
  const rejected = assert.rejects(attempt, /Interactive cell sources changed after runtime generation started\./u);
  await entered.promise;
  const authoredPage = path.join(workspaceRoot, 'content/docs/index.mdx');
  await writeFile(
    authoredPage,
    `${await readFile(authoredPage, 'utf8')}\n\n\`\`\`rust\n//| id: settled\n//| crates: []\nprintln!("settled cell");\n\`\`\`\n`
  );
  resume.resolve();
  await rejected;
  assert.deepEqual(await readFile(await rustAsset('wasm')), publishedWasm);
  assert.deepEqual(await readFile(paths.runtimeVersionPath), publishedReady);
  const settled = await syncDocRuntime({ ...context, mode: 'dev' });
  const settledManifest = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
  assert.equal(settledManifest.generationId, settled.generationId);
  const settledCell = settledManifest.cells.find((cell) => cell.id.endsWith('__settled'));
  assert.ok(settledCell, 'settled rebuild must include the newly authored cell');
  const settledRuntime = await import(`${pathToFileURL(await rustAsset('glue')).href}?settled`);
  settledRuntime.initSync({ module: await readFile(await rustAsset('wasm')) });
  assert.equal(JSON.parse(settledRuntime.run_rust_cell(settledCell.id, '{}')).outputs[0].content, 'settled cell\n');
  publishedWasm = await readFile(await rustAsset('wasm'));

  await writeFile(
    path.join(workspaceRoot, 'content/docs/index.mdx'),
    '```rust\n//| id: failure\nthis_is_not_valid_rust!();\n```\n'
  );
  await assert.rejects(
    runCli(['docgen', '--wasm', 'dev'], {
      cwd: workspaceRoot,
      loadProjectConfig: async () => ({ astroConfigArgs: [], cwd: workspaceRoot, paths })
    })
  );
  assert.deepEqual(await readFile(await rustAsset('wasm')), publishedWasm);
  await readFile(paths.runtimeVersionPath);

  for (const [id, source, kind] of [
    ['area-only', 'emit_area_chart!(&[[0, 1]]);', 'chart'],
    [
      'generic-only',
      'emit_chart!(serde_json::json!({ "kind": "xy", "layers": [{ "id": "reference", "kind": "line", "points": [[0, 1]] }, { "id": "samples", "kind": "scatter", "points": [[0, 1.1]] }, { "id": "band", "kind": "band", "points": [[0, 1, 0.5, 1.5]] }] }));',
      'chart'
    ],
    ['alias-only', 'emit_svg!(r#"<svg xmlns="http://www.w3.org/2000/svg"/>"#);', 'image']
  ]) {
    await writeFile(
      path.join(workspaceRoot, 'content/docs/index.mdx'),
      `---\ntitle: Isolated capability\n---\n\n\`\`\`rust\n//| id: ${id}\n${source}\n\`\`\`\n`
    );
    await runCli(['docgen', '--wasm', 'dev'], {
      cwd: workspaceRoot,
      loadProjectConfig: async () => ({ astroConfigArgs: [], cwd: workspaceRoot, paths })
    });
    const isolated = await import(`${pathToFileURL(await rustAsset('glue')).href}?${id}`);
    isolated.initSync({ module: await readFile(await rustAsset('wasm')) });
    const [cell] = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8')).cells;
    const result = JSON.parse(isolated.run_rust_cell(cell.id, '{}'));
    assert.equal(result.outputs[0].kind, kind, id);
    assert.equal(validateOutputArtifacts(result.outputs)[0].status, 'valid', id);
  }
  for (const [file, before] of dependencyTimes) {
    assert.equal(
      (await stat(file)).mtimeMs,
      before,
      `registry dependency must survive cell edits and failed builds: ${file}`
    );
  }
  await readFile(paths.runtimeVersionPath);
  console.log('Generated Rust/Wasm regressions and incremental dependency reuse passed.');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
