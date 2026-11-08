import { pathToFileURL } from 'node:url';
import { normalizeCellExecutionResult } from '../../packages/oxiquill/dist/lib/doc-runtime/output-artifacts.js';
import { boundWorkerResult } from '../../packages/oxiquill/dist/lib/doc-runtime/worker-output.js';
import { cacheableResult } from '../../packages/oxiquill/dist/lib/doc-runtime/producer-result-cache.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { collectAuthoringCells } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-collection.mjs';
import { createCellTestPlan } from '../../packages/oxiquill/dist/generator/doc-runtime/cell-test-plan.mjs';
import { testGeneratedRustCells } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-runtime-test.mjs';
import { rustModuleForCell } from '../../packages/oxiquill/dist/lib/doc-runtime/rust-registry.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-data-dependencies-'));
const paths = createOxiquillPaths({ workspaceRoot: root });
const fence = (metadata, source) => `\`\`\`rust\n//| ${JSON.stringify(metadata)}\n${source}\n\`\`\`\n`;
const errorTest = (error) => ({ tests: [{ case: 'default', expect: [{ error }] }] });
const producer = (id, source, error, metadata = {}) =>
  fence({ id, exports: ['value'], ...(error ? errorTest(error) : {}), ...metadata }, source);
const blocks = [
  fence(
    { id: 'model', kind: 'definitions' },
    '#[derive(serde::Deserialize)]\npub(crate) struct Data { pub(crate) value: i32 }'
  ),
  fence(
    { id: 'borrowed-model', kind: 'definitions' },
    "#[derive(serde::Deserialize)]\npub(crate) struct Borrowed<'a> { pub(crate) value: &'a str }"
  ),
  producer('text', 'export!(value, &"borrowed");'),
  fence(
    {
      id: 'borrowed',
      uses: ['borrowed-model'],
      dependsOn: { data: { cell: 'text', type: "Borrowed<'_>" } },
      tests: [{ case: 'default', expect: [{ path: '/outputs/0/content', equals: 'Borrowed borrowed\n' }] }]
    },
    'println!("Borrowed {}", data.value);'
  ),
  producer('source', 'export!(value, &seed);', undefined, {
    cache: 'inputs',
    inputs: { seed: { type: 'integer', value: 7 } }
  }),
  producer('left', 'export!(value, &(data.value + 1));', undefined, {
    uses: ['model'],
    dependsOn: { data: { cell: 'source', type: 'Data' } }
  }),
  producer('right', 'export!(value, &(data["value"].as_i64().ok_or("integer required")? + 2));', undefined, {
    dependsOn: { data: 'source' }
  }),
  fence(
    {
      id: 'final',
      dependsOn: { left: 'left', right: 'right' },
      inputs: { bias: { type: 'integer', value: 0 } },
      cases: [{ id: 'adjusted', label: 'Adjusted', inputs: { bias: 5 } }],
      tests: [
        { case: 'default', expect: [{ path: '/outputs/0/content', equals: '17\n' }] },
        { case: 'adjusted', expect: [{ path: '/outputs/0/content', equals: '22\n' }] }
      ]
    },
    'println!("{}", left["value"].as_i64().ok_or("left")? + right["value"].as_i64().ok_or("right")? + i64::from(bias));'
  ),
  producer(
    'finite',
    '#[derive(Serialize)]\nstruct Nested { array: Vec<Option<f64>>, pair: (i32, bool), unit: (), text: String }\nlet nested = Nested { array: vec![Some(1.0), None], pair: (2, true), unit: (), text: "日本語".to_owned() };\nexport!(value, &nested);'
  ),
  producer(
    'stdout-overflow',
    'println!("stdout");\n(0..100).for_each(|_| emit_text!("display"));\nexport!(value, &1);'
  ),
  producer(
    'response-overflow',
    'export!(value, &"x".repeat(3 * 1024 * 1024));\n(0..15).for_each(|_| emit_text!(&"y".repeat(1024 * 1024)));'
  ),
  producer('missing', 'let _value = 1;', 'Producer missing is missing export value'),
  producer('undeclared', 'export!(other, &1);', 'undeclared export other'),
  producer('nan', 'export!(value, &vec![Some(f64::NAN)]);', 'non-finite export data'),
  producer(
    'infinity',
    'export!(value, &std::collections::BTreeMap::from([("nested", f64::INFINITY)]));',
    'non-finite export data'
  ),
  producer('oversize', 'export!(value, &"x".repeat(4 * 1024 * 1024));', 'export data exceeded'),
  fence(
    { id: 'aggregate', exports: ['left', 'right'], ...errorTest('export data exceeded') },
    'export!(left, &"x".repeat(3 * 1024 * 1024));\nexport!(right, &"y".repeat(3 * 1024 * 1024));'
  ),
  producer('overwrite', 'export!(value, &1);\nexport!(value, &2);', undefined, {
    tests: [{ case: 'default', expect: [{ path: '/exports/value', equals: 2 }] }]
  }),
  fence(
    {
      id: 'deserialize',
      dependsOn: { data: { cell: 'finite', type: 'Vec<i32>' } },
      ...errorTest('Producer data__finite could not deserialize binding data')
    },
    'println!("{}", data.len());'
  ),
  fence(
    { id: 'failed-consumer', dependsOn: { data: 'missing' }, ...errorTest('Upstream cell "missing" failed') },
    'println!("{data}");'
  )
];
try {
  await mkdir(paths.docsDir, { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}');
  await writeFile(path.join(paths.docsDir, 'data.mdx'), ['---\ntitle: Data dependencies\n---', ...blocks].join('\n'));
  for (const grouping of ['page', 'directory', 'site', () => 'data']) {
    const context = await createDocRuntimeContext({ paths, rustOptions: { grouping } });
    await syncDocRuntime({ ...context, mode: 'dev', languages: ['rust'] });
    const manifest = JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
    const descriptor = rustModuleForCell(manifest.rust, 'data__stdout-overflow');
    const runtime = await import(pathToFileURL(path.join(paths.publicDir, descriptor.glue.url)).href);
    runtime.initSync({
      module: await WebAssembly.compile(await readFile(path.join(paths.publicDir, descriptor.wasm.url)))
    });
    for (const id of ['stdout-overflow', 'response-overflow']) {
      const raw = JSON.parse(runtime.run_rust_cell(`data__${id}`, '{}', '{}'));
      const normalized = normalizeCellExecutionResult(boundWorkerResult(raw));
      assert.ok(
        normalized.outputResults.some((output) => output.status === 'error'),
        `${id} must report omitted output`
      );
      assert.equal(cacheableResult(normalized), false, `${id} must never be cached`);
    }
    const cells = await collectAuthoringCells(context);
    const plan = createCellTestPlan(cells, {}, paths);
    const failures = [];
    const result = await testGeneratedRustCells({
      tests: plan.tests,
      paths,
      report: (event) => {
        if (event.status === 'fail') failures.push(event);
      }
    });
    assert.equal(result.failed, 0, JSON.stringify(failures, null, 2));
    // Selecting only the final cell still computes the entire dependency closure.
    const selected = createCellTestPlan(cells, { page: ['data.mdx'], cell: ['final'], case: ['adjusted'] }, paths);
    assert.equal((await testGeneratedRustCells({ tests: selected.tests, paths, report: () => {} })).failed, 0);
  }
  console.log('Rust data dependency smoke tests passed (page, directory, site, and function grouping).');
} finally {
  await rm(root, { recursive: true, force: true });
}
