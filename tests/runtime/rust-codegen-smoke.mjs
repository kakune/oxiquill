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
  const cell = manifest.find((entry) => entry.id.endsWith('__spaced-macros'));
  assert.ok(cell, 'spaced invocation fixture must be generated');
  const output = JSON.parse(runtime.run_rust_cell(cell.id, '{}'));
  assert.equal(output.stdout, 'spaced output\n');
  assert.deepEqual(output.outputs.find((artifact) => artifact.kind === 'json')?.value, { ok: true });
  assert.equal(
    output.outputs.find((artifact) => artifact.kind === 'image')?.data,
    '<svg xmlns="http://www.w3.org/2000/svg"/>'
  );
  console.log('Generated Rust/Wasm code generation regressions passed.');
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
