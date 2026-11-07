// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { createBuildGeneration } from '../../packages/oxiquill/src/astro/build-generation.mjs';
import { oxiquillVirtualModulesPlugin } from '../../packages/oxiquill/src/astro/virtual-modules.mjs';
import remarkInteractiveCells from '../../packages/oxiquill/src/lib/doc-runtime/remark-interactive-cells.mjs';
import { parseCellsFromMarkdown } from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import {
  assertGenerationSnapshot,
  createGenerationSnapshot,
  diffGenerationSnapshots,
  readGenerationSnapshot,
  sourceChangedError
} from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';

const roots = [];
const pagePath = 'content/docs/index.mdx';
const source = '```rust\n//| id: demo\nprintln!("first");\n```\n';
const changedMessage = 'Interactive cell sources changed after runtime generation started.';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-generation-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  await mkdir(paths.docsDir, { recursive: true });
  await mkdir(paths.generatedDir, { recursive: true });
  const page = path.join(root, pagePath);
  await writeFile(page, source);
  const snapshot = await readGenerationSnapshot({ paths });
  const manifest = { generationId: snapshot.generationId, cells: snapshot.cells };
  await writeFile(paths.cellsJsonPath, JSON.stringify(manifest));
  await writeFile(paths.runtimeOwnershipPath, JSON.stringify({ generationId: snapshot.generationId, snapshot }));
  return { paths, page, snapshot, manifest };
}

describe('generation snapshots and build guards', () => {
  it('owns a deeply immutable, deterministic snapshot without highlighting or author locations', () => {
    const cells = parseCellsFromMarkdown(source, pagePath).cells;
    const before = createGenerationSnapshot(cells, [{ path: 'crates/helper/src/lib.rs', digest: 'one' }]);
    const after = createGenerationSnapshot(
      cells.map((cell) => ({ ...cell, fenceStartLine: 99, sourceHtml: 'new theme' })),
      before.helpers
    );
    expect(after).toEqual(before);
    cells[0].source = 'mutated';
    expect(before.cells[0].source).toBe('println!("first");');
    expect(Object.isFrozen(before.cells[0].inputs)).toBe(true);
    expect(
      createGenerationSnapshot([...before.cells, { ...before.cells[0], id: 'a' }], [...before.helpers].reverse())
    ).toEqual(createGenerationSnapshot([{ ...before.cells[0], id: 'a' }, ...before.cells], before.helpers));
  });

  it('lists every cell and helper difference with local IDs, paths, and fields', () => {
    const cells = parseCellsFromMarkdown(source, pagePath).cells;
    const before = createGenerationSnapshot(
      [...cells, { ...cells[0], id: 'index__removed' }],
      [
        { path: 'crates/a', digest: 'one' },
        { path: 'crates/removed', digest: 'old' }
      ]
    );
    const after = createGenerationSnapshot(
      [
        { ...cells[0], source: 'new', timeoutMs: 5 },
        { ...cells[0], id: 'new__added', pagePath: 'content/docs/new.mdx' }
      ],
      [
        { path: 'crates/a', digest: 'two' },
        { path: 'crates/added', digest: 'new' }
      ]
    );
    const error = sourceChangedError(diffGenerationSnapshots(before, after));
    expect(error.message).toBe(
      [
        changedMessage,
        '  changed: content/docs/index.mdx (cell "demo": source, timeoutMs)',
        '  removed: content/docs/index.mdx (cell "removed")',
        '  added:   content/docs/new.mdx (cell "added")',
        '  changed: crates/a',
        '  added:   crates/added',
        '  removed: crates/removed',
        'Rerun `oxiquill build` once the sources are settled.'
      ].join('\n')
    );
    expect(diffGenerationSnapshots(before, before)).toEqual([]);
  });

  it('uses one generation for MDX and main/worker virtual modules and pins its manifest', async () => {
    const { paths, page, snapshot, manifest } = await fixture();
    const generation = createBuildGeneration({ paths, generationId: snapshot.generationId });
    const tree = parseCellsFromMarkdown(source, pagePath).tree;
    remarkInteractiveCells({ root: paths.workspaceRoot, generation })(tree, { path: page });
    expect(tree.children[0].value).toContain(`&generationId=${snapshot.generationId}`);
    // Later loads cannot silently switch to another manifest.
    await writeFile(paths.cellsJsonPath, JSON.stringify({ generationId: 'different', cells: [] }));
    for (const plugin of [
      oxiquillVirtualModulesPlugin(paths, { generation }),
      oxiquillVirtualModulesPlugin(paths, { generation })
    ]) {
      const context = { addWatchFile: vi.fn() };
      const load = (id) => plugin.load.call(context, `\0virtual:oxiquill/${id}`);
      expect(load(`cell?cellId=index__demo&generationId=${snapshot.generationId}`)).toContain(
        JSON.stringify(manifest.cells[0])
      );
      expect(load('cells')).toContain(`export const generationId = "${snapshot.generationId}";`);
      expect(() => load('cell?cellId=index__demo&generationId=different')).toThrow(changedMessage);
      expect(() => load(`cell?cellId=index__missing&generationId=${snapshot.generationId}`)).toThrow(changedMessage);
    }
  });

  it('rejects changed, extra, and missing cells during the page transform', async () => {
    const { paths, page, snapshot } = await fixture();
    const generation = createBuildGeneration({ paths });
    generation.start(snapshot.generationId);
    for (const actual of [
      source.replace('first', 'second'),
      source + source.replace('id: demo', 'id: extra'),
      '# Prose only\n'
    ]) {
      const tree = parseCellsFromMarkdown(actual, pagePath).tree;
      await expect(
        remarkInteractiveCells({ root: paths.workspaceRoot, generation })(tree, { path: page })
      ).rejects.toThrow(changedMessage);
    }
    expect(() => generation.validatePage(pagePath, snapshot.cells)).not.toThrow();
  });

  it('checks disk at build completion, accepting prose edits and rejecting cells and helpers', async () => {
    const { paths, page, snapshot } = await fixture();
    const generation = createBuildGeneration({ paths, generationId: snapshot.generationId });
    await writeFile(page, `# New prose\n\n${source}`);
    await expect(generation.checkSources()).resolves.toBeUndefined();
    await writeFile(page, source.replace('first', 'second'));
    await expect(generation.checkSources()).rejects.toThrow('cell "demo": source');
    await writeFile(page, source);
    await mkdir(paths.cratesDir, { recursive: true });
    await writeFile(path.join(paths.cratesDir, 'new-helper.txt'), 'changed');
    await expect(generation.checkSources()).rejects.toThrow('added:   crates/new-helper.txt');
  });

  it('includes other changed pages and helpers when a transformed cell differs', async () => {
    const { paths, page, snapshot } = await fixture();
    const generation = createBuildGeneration({ paths, generationId: snapshot.generationId });
    await writeFile(path.join(paths.docsDir, 'other.mdx'), source);
    await mkdir(paths.cratesDir, { recursive: true });
    await writeFile(path.join(paths.cratesDir, 'data.txt'), 'helper input');
    const tree = parseCellsFromMarkdown(source.replace('first', 'second'), pagePath).tree;
    await expect(
      remarkInteractiveCells({ root: paths.workspaceRoot, generation })(tree, { path: page })
    ).rejects.toThrow(
      '  changed: content/docs/index.mdx (cell "demo": source)\n  added:   content/docs/other.mdx (cell "demo")\n  added:   crates/data.txt'
    );
    await writeFile(page, source.replace('id: demo', 'id: INVALID'));
    await expect(generation.validatePage(pagePath, [])).rejects.toThrow(changedMessage);
  });

  it('reports temporarily invalid sources through the same checkpoint diagnostic', async () => {
    const { paths, page, snapshot } = await fixture();
    await writeFile(page, source.replace('id: demo', 'id: INVALID'));
    await expect(assertGenerationSnapshot(snapshot, { paths })).rejects.toThrow(changedMessage);
  });

  it('requires matching manifest and state metadata, including for empty manifests', async () => {
    const { paths, snapshot } = await fixture();
    const generation = createBuildGeneration({ paths });
    expect(generation.current()).toBeUndefined();
    expect(generation.validatePage(pagePath, [])).toBeUndefined();
    await expect(generation.checkSources()).resolves.toBeUndefined();
    expect(() => generation.start('wrong')).toThrow(changedMessage);
    await writeFile(paths.cellsJsonPath, '[]');
    expect(() => generation.start(snapshot.generationId)).toThrow(changedMessage);
    await writeFile(paths.cellsJsonPath, 'invalid');
    expect(() => generation.start(snapshot.generationId)).toThrow(changedMessage);
    const empty = createGenerationSnapshot([], []);
    await writeFile(paths.cellsJsonPath, JSON.stringify({ generationId: empty.generationId, cells: [] }));
    await writeFile(paths.runtimeOwnershipPath, JSON.stringify({ generationId: empty.generationId, snapshot: empty }));
    generation.start(empty.generationId);
    expect(generation.current().cells).toEqual([]);
    expect(JSON.parse(await readFile(paths.cellsJsonPath, 'utf8')).generationId).toBe(empty.generationId);
  });
});
