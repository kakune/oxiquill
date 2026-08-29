import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const reportPath = path.join(repositoryRoot, 'examples/docs-site/dist/oxiquill/bundle-report.json');
const report = JSON.parse(await readFile(reportPath, 'utf8'));

assert.equal(report.schemaVersion, 1, 'Unexpected browser bundle report schema');
assert.equal(report.limitBytes, 650 * 1024, 'Unexpected browser bundle limit');
assert.ok(report.chunks.length > 0, 'Browser bundle report contains no chunks');

report.chunks.forEach((chunk) => {
  assert.ok(chunk.uncompressedBytes <= report.limitBytes, `${chunk.fileName} exceeds ${report.limitBytes} bytes`);
});

assertDynamicPackageBoundary('InteractiveCell.js', 'echarts/');
assertDynamicPackageBoundary('MermaidDiagram.js', 'mermaid/');

for (const worker of ['rust-worker.js', 'python-worker.js', 'haskell-worker.js']) {
  const chunk = findEntryChunk(worker);
  assert.equal(chunk.source, 'worker', `${worker} is not isolated in a worker bundle`);
}

console.log(`Verified ${report.chunks.length} browser chunks against the ${report.limitBytes}-byte budget.`);

function assertDynamicPackageBoundary(entrySuffix, packagePrefix) {
  const entry = findEntryChunk(entrySuffix);
  const initialGraph = collectGraph([entry.fileName], false);
  const initialModules = collectModules(initialGraph);

  assert.ok(
    initialModules.every((moduleId) => !moduleId.startsWith(packagePrefix)),
    `${packagePrefix} is statically reachable from ${entrySuffix}`
  );

  const dynamicRoots = initialGraph.flatMap((chunk) => chunk.dynamicImports);
  const dynamicModules = collectModules(collectGraph(dynamicRoots, true));
  assert.ok(
    dynamicModules.some((moduleId) => moduleId.startsWith(packagePrefix)),
    `${packagePrefix} is missing from the dynamic graph for ${entrySuffix}`
  );
}

function findEntryChunk(suffix) {
  const chunk = report.chunks.find((candidate) => candidate.entryModule?.endsWith(suffix));
  assert.ok(chunk, `Could not find the entry chunk for ${suffix}`);
  return chunk;
}

function collectGraph(roots, includeDynamicImports) {
  const chunksByName = new Map(report.chunks.map((chunk) => [chunk.fileName, chunk]));
  const visited = new Set();
  const pending = [...roots];

  while (pending.length > 0) {
    const fileName = pending.shift();
    if (visited.has(fileName)) continue;

    const chunk = chunksByName.get(fileName);
    if (!chunk) continue;

    visited.add(fileName);
    pending.push(...chunk.imports);
    if (includeDynamicImports) pending.push(...chunk.dynamicImports);
  }

  return Array.from(visited, (fileName) => chunksByName.get(fileName));
}

function collectModules(chunks) {
  return chunks.flatMap((chunk) => chunk.modules);
}
