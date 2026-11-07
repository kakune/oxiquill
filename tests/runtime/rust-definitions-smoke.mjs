import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import {
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { runProcess } from '../../packages/oxiquill/dist/generator/doc-runtime/process-runner.mjs';
import { testGeneratedRustCells } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-runtime-test.mjs';
import { collectAuthoringCells } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-collection.mjs';
import { createCellTestPlan } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-test-plan.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-definitions-'));
const paths = createOxiquillPaths({ workspaceRoot: root });
const page = path.join(paths.docsDir, 'definitions.mdx');
const fence = (metadata, source) =>
  `\`\`\`rust\n${metadata.map((line) => `//| ${line}`).join('\n')}\n${source}\n\`\`\`\n`;
const authored = [
  '---\ntitle: Shared definitions\n---\n',
  fence(
    ['id: model', 'kind: definitions', 'crates: [defs-helper]'],
    'pub(crate) struct Model { pub(crate) a: i32 }\npub(crate) fn value(model: &Model) -> i32 { model.a }'
  ),
  fence(['id: helper', 'kind: definitions', 'uses: [model]'], 'pub(crate) fn make() -> Model { Model { a: 7 } }'),
  fence(
    ['id: unused', 'kind: definitions', 'crates: [unused-helper]'],
    'compile_error!("unused definitions must not compile");'
  ),
  fence(
    [
      'id: first',
      'uses: [model]',
      'tests:',
      '  - case: default',
      '    expect: [{ path: /outputs/0/content, equals: "7\\n" }]'
    ],
    'let model = Model { a: 7 };\nprintln!("{}", value(&model));'
  ),
  fence(['id: second', 'uses: [model]'], 'let model = Model { a: 8 };\nprintln!("{}", value(&model));'),
  fence(['id: third', 'uses: [model, helper]'], 'println!("{}", value(&make()));')
].join('\n');

try {
  await mkdir(paths.docsDir, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
  for (const [name, source] of [
    ['defs-helper', 'pub fn value() -> i32 { 7 }'],
    ['unused-helper', 'compile_error!("unused helper must not compile");']
  ]) {
    const directory = path.join(root, 'crates', name);
    await mkdir(path.join(directory, 'src'), { recursive: true });
    await writeFile(
      path.join(directory, 'Cargo.toml'),
      `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n`
    );
    await writeFile(path.join(directory, 'src/lib.rs'), source);
  }
  for (const grouping of ['site', 'page']) {
    await writeFile(page, authored);
    const checks = [];
    const context = await createDocRuntimeContext({ paths, rustOptions: { grouping } });
    const sync = (overrides = {}) =>
      syncDocRuntime({
        ...context,
        mode: 'dev',
        runCommand: (command, args, options) => {
          if (command === 'cargo' && args[0] === 'check') checks.push(args);
          return runProcess(command, args, options);
        },
        ...overrides
      });
    await sync();
    assert.equal(checks.length, 0, 'successful builds never run a diagnostic check');
    const manifestBytes = await readFile(paths.cellsJsonPath);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.cells.length, 3);
    assert.equal(manifest.definitions.length, 3);
    assert.equal(manifest.rust.modules.flatMap((module) => module.cells).length, 3);
    const plan = createCellTestPlan(await collectAuthoringCells(context), {}, paths);
    assert.equal((await testGeneratedRustCells({ tests: plan.tests, paths, report: () => {} })).failed, 0);
    const untouched = await sync();
    assert.equal(untouched.plan.languages.rust.public, 'keep');
    await writeFile(page, authored.replace('unused definitions must not compile', 'still unused'));
    assert.equal((await sync()).plan.languages.rust.public, 'keep');
    for (const [before, after, expected] of [
      ['model.a }', 'model.missing() }', /definitions.mdx:\d+:\d+ \[cell definitions__model\]/u],
      ['pub(crate) a: i32', 'pub(crate) a: MissingType', /definitions.mdx:\d+:\d+ \[cell definitions__model\]/u],
      [
        'let model = Model { a: 7 };',
        'let label = "日本語"; label.missing();\nlet model = Model { a: 7 };',
        /definitions.mdx:\d+:\d+ \[cell definitions__first\]/u
      ],
      [
        'let model = Model { a: 7 };',
        'let n: u8 = "wrong";\nlet model = Model { a: 7 };',
        /definitions.mdx:\d+:\d+ \[cell definitions__first\]/u
      ],
      [
        'let model = Model { a: 7 };',
        'let broken = ;\nlet model = Model { a: 7 };',
        /definitions.mdx:\d+:\d+ \[cell definitions__first\]/u
      ],
      [
        'let model = Model { a: 7 };',
        'println!(\n "{}",\n unknown_name\n);\nlet model = Model { a: 7 };',
        /definitions.mdx:\d+:\d+ \[cell definitions__first\]/u
      ],
      ['pub(crate) struct Model', 'struct Model', /definitions.mdx:\d+:\d+/u]
    ]) {
      const invalid = authored.replace(before, after).replaceAll('\n', '\r\n');
      await writeFile(page, invalid);
      const previousChecks = checks.length;
      await assert.rejects(sync(), (error) => {
        assert.match(error.message, expected);
        assert.ok(error.exitCode > 0);
        assert.ok(error.rustDiagnostics.length > 0);
        assert.match(error.message, /Original build error:/u);
        const token = after.includes('missing()')
          ? 'missing'
          : after.includes('MissingType')
            ? 'MissingType'
            : after.includes('unknown_name')
              ? 'unknown_name'
              : after.includes('"wrong"')
                ? '"wrong"'
                : undefined;
        if (token) {
          const lines = invalid.split(/\r?\n/u);
          const index = lines.findIndex((line) => line.includes(token));
          const column = Array.from(lines[index].slice(0, lines[index].indexOf(token))).length + 1;
          assert.ok(
            error.rustDiagnostics
              .flatMap((diagnostic) => diagnostic.spans)
              .some(
                (span) => span.kind === 'authored' && span.primary && span.line === index + 1 && span.column === column
              ),
            `expected authored ${index + 1}:${column}`
          );
        }
        return true;
      });
      assert.equal(checks.length, previousChecks + 1);
      // Unused-source rendering can have changed, but failed compilation retains
      // the last successful runtime registry and executable entries.
      const retained = JSON.parse(await readFile(paths.cellsJsonPath));
      assert.deepEqual(retained.rust, manifest.rust);
      assert.deepEqual(retained.cells, manifest.cells);
    }
    await writeFile(page, authored);
    await sync();
    assert.deepEqual(
      JSON.parse(await readFile(path.join(paths.buildCacheDir, 'rust-dev-diagnostics.json'))).compileErrors,
      []
    );
    const helperFile = path.join(root, 'crates/defs-helper/src/lib.rs');
    await writeFile(helperFile, 'pub fn value() -> i32 { "wrong" }');
    await assert.rejects(sync(), (error) => {
      assert.match(error.message, /crates[\\/]defs-helper[\\/]src[\\/]lib.rs/u);
      assert.ok(
        error.rustDiagnostics
          .flatMap((diagnostic) => diagnostic.spans)
          .every((span) => span.kind === 'external' && !span.cellId)
      );
      return true;
    });
    await writeFile(helperFile, 'pub fn value() -> i32 { 7 }');
    await sync();
    const moved = path.join(paths.docsDir, 'moved.mdx');
    await rename(page, moved);
    await writeFile(moved, `\n\n${authored.replace('model.a }', 'model.missing() }')}`);
    await assert.rejects(sync(), /content\/docs\/moved.mdx:\d+:\d+ \[cell moved__model\]/u);
    await rename(moved, page);
    await writeFile(page, authored);
    await sync();
  }
  console.log('Rust definitions and authored diagnostics smoke passed (site and page).');
} finally {
  await rm(root, { recursive: true, force: true });
}
