import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';

const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-rust-codegen-'));
const paths = createOxiquillPaths({ workspaceRoot });

try {
  await cp(new URL('../fixtures/rust-codegen/', import.meta.url), workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await runCli(['test-wasm'], {
    cwd: workspaceRoot,
    loadProjectConfig: async () => ({ astroConfigArgs: [], cwd: workspaceRoot, paths })
  });
  const runtime = await import(pathToFileURL(path.join(paths.rustWasmPublicDir, 'doc_rust_cells.js')).href);
  runtime.initSync({ module: await readFile(path.join(paths.rustWasmPublicDir, 'doc_rust_cells_bg.wasm')) });
  const manifest = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
  const run = (name, inputs = {}) => {
    const cell = manifest.find((entry) => entry.id.endsWith(`__${name}`));
    assert.ok(cell, `${name} fixture must be generated`);
    return JSON.parse(runtime.run_rust_cell(cell.id, JSON.stringify(inputs)));
  };
  const output = run('spaced-macros');
  assert.equal(output.stdout, 'spaced output\n');
  assert.deepEqual(output.outputs.find((artifact) => artifact.kind === 'json')?.value, { ok: true });
  assert.equal(
    output.outputs.find((artifact) => artifact.kind === 'image')?.data,
    '<svg xmlns="http://www.w3.org/2000/svg"/>'
  );

  const collision = run('colliding-locals');
  assert.equal(collision.stdout, 'author value:42\n\n');
  assert.deepEqual(collision.outputs, [
    { kind: 'text', stream: 'stdout', content: 'author value:42\n\n', truncated: false },
    { kind: 'json', value: { label: 'author value', number: 42 }, truncated: false }
  ]);
  const inputs = run('inputs-and-question-mark', { label: 'custom input', fail: false });
  assert.equal(inputs.stdout, 'custom input:42\n');
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
  assert.equal(run('early-return', { early: false }).stdout, 'normal return\n');
  assert.deepEqual(run('early-return', { early: true }), {
    stdout: 'early return',
    plots: [],
    value: null,
    outputs: []
  });
  console.log('Generated Rust/Wasm code generation regressions passed.');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
