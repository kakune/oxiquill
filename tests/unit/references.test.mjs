// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { createReferences } from '../../packages/oxiquill/src/astro/references.mjs';
import { parseCellsFromMarkdown } from '../../packages/oxiquill/src/generator/doc-runtime/cell-parser.mjs';
import {
  assertGenerationSnapshot,
  readGenerationSnapshot
} from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';
import {
  createReferenceRegistry,
  pageLocale,
  pageRoute,
  parsePageFrontmatter,
  resolveReference,
  validReferenceName
} from '../../packages/oxiquill/src/lib/doc-runtime/references.mjs';
import remarkReferences from '../../packages/oxiquill/src/lib/doc-runtime/remark-references.mjs';
import rehypeReferences from '../../packages/oxiquill/src/lib/doc-runtime/rehype-references.mjs';

const roots = [];
const config = {
  base: '/manual/',
  i18n: {
    defaultLocale: 'en',
    locales: [
      { path: 'en', codes: ['en'] },
      { path: 'ja', codes: ['ja-JP'] }
    ],
    routing: { prefixDefaultLocale: false }
  }
};
const targetSource =
  '---\ntitle: Target\nreferences:\n  step-size: choosing-the-step-size\n---\n\n## Choosing the step size\n';
const page = (entryPath, source = targetSource) => ({
  ...parseCellsFromMarkdown(source, `content/docs/${entryPath}`).page,
  entryPath
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-references-'));
  roots.push(root);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  await mkdir(paths.docsDir, { recursive: true });
  await mkdir(paths.cratesDir, { recursive: true });
  const file = path.join(paths.docsDir, 'target.mdx');
  await writeFile(file, targetSource);
  return { root, paths, file };
}

describe('reference declarations and routes', () => {
  it.each(['a', 'solver-demo', 'a'.repeat(64)])('accepts %s', (name) => expect(validReferenceName(name)).toBe(true));
  it.each(['', 'Bad', 'a_b', 'a--b', 'a-', '-a', '1a', '日本語', 'a'.repeat(65), 3, null])('rejects %s', (name) =>
    expect(validReferenceName(name)).toBe(false)
  );

  it.each(['rust', 'python', 'haskell'])('parses %s cell references and retains exact source locations', (language) => {
    const prefix = { rust: '//|', python: '#|', haskell: '--|' }[language];
    const source = `---\ntitle: Demo\n---\n\n\`\`\`${language}\n${prefix} id: demo\n${prefix} ref: solver-demo\nprint("ok")\n\`\`\``;
    const parsed = parseCellsFromMarkdown(source, 'content/docs/demo.mdx');
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.cells[0]).toMatchObject({ ref: 'solver-demo', refPosition: { line: 7, column: prefix.length + 7 } });
    expect(parsed.page.cellReferences[0]).toMatchObject({ name: 'solver-demo', cellId: 'demo__demo' });
  });

  it('locates indented reference metadata in the original source', () => {
    const parsed = parseCellsFromMarkdown(
      '   ```python\n   #| id: demo\n   #| ref: solver-demo\n   print(1)\n   ```',
      'page.mdx'
    );
    expect(parsed.cells[0].refPosition).toEqual({ line: 3, column: 12 });
  });

  it('reports invalid cell references at the metadata value', () => {
    const parsed = parseCellsFromMarkdown('```python\n#| id: demo\n#| ref: Bad\nprint(1)\n```', 'page.mdx');
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ fieldPath: 'ref', line: 3, column: 9 }));
  });

  it('extracts frontmatter references without losing body line numbers', () => {
    const parsed = parseCellsFromMarkdown(targetSource, 'target.mdx');
    expect(parsed.page.references).toEqual([
      { name: 'step-size', slug: 'choosing-the-step-size', position: { line: 4, column: 3 } }
    ]);
    expect(parsed.tree.children[0]).toMatchObject({ type: 'heading', position: { start: { line: 7 } } });
    expect(parsePageFrontmatter('Text', 'page.md').references).toEqual([]);
  });

  it.each([
    ['references: []', 'Expected a mapping'],
    ['references:\n  Bad: heading', 'Invalid reference name'],
    ['references:\n  valid: 3', 'Expected a non-empty heading slug'],
    ['references: [', 'Flow sequence'],
    ['references:\n  repeated: first\n  repeated: second', 'first declared at page.mdx:3:3']
  ])('rejects malformed frontmatter: %s', (metadata, message) => {
    expect(() => parsePageFrontmatter(`---\n${metadata}\n---\n`, 'page.mdx')).toThrow(message);
    expect(() => parsePageFrontmatter(`---\n${metadata}\n---\n`, 'page.mdx')).toThrow(/page\.mdx:\d+:\d+/u);
  });

  it.each([
    ['index.mdx', {}, '/manual/'],
    ['nested/index.md', {}, '/manual/nested/'],
    ['My Page.mdx', {}, '/manual/my-page/'],
    ['Section/My Page.mdx', {}, '/manual/section/my-page/'],
    ['ja/日本語.mdx', {}, '/manual/ja/日本語/'],
    ['nested/demo.mdx', { trailingSlash: 'never' }, '/manual/nested/demo'],
    ['nested/demo.mdx', { trailingSlash: 'always' }, '/manual/nested/demo/'],
    ['index.mdx', { build: { format: 'file' } }, '/manual/index.html'],
    ['index.mdx', { trailingSlash: 'never' }, '/manual'],
    ['nested/demo.mdx', { build: { format: 'file' } }, '/manual/nested/demo.html']
  ])('matches the route for %s with %j', (entry, options, expected) =>
    expect(pageRoute(page(entry), { ...config, ...options })).toBe(expected)
  );

  it('honors full frontmatter slug overrides and locale routing', () => {
    const target = page('old/path.mdx', targetSource.replace('title: Target', 'title: Target\nslug: ja/custom/index'));
    expect(pageRoute(target, config)).toBe('/manual/ja/custom/');
    expect(pageRoute({ ...target, slug: 'custom.html' }, config)).toBe('/manual/custom');
    expect(pageRoute({ ...target, slug: 'custom.html' }, { ...config, trailingSlash: 'always' })).toBe(
      '/manual/custom/'
    );
    expect(pageRoute({ ...target, slug: 'custom.html' }, { ...config, build: { format: 'file' } })).toBe(
      '/manual/custom.html'
    );
    expect(pageLocale(target, config)).toBe('ja');
    expect(pageLocale(page('notes/topic.mdx'), config)).toBe('root');
    expect(pageLocale(page('ja/index.mdx'), config)).toBe('ja');
    expect(
      pageLocale(page('topic.mdx'), {
        i18n: { ...config.i18n, defaultLocale: 'en', routing: { prefixDefaultLocale: true } }
      })
    ).toBe('en');
  });

  it('rejects duplicate names across target kinds, reporting both declarations', () => {
    const cell = page('cell.mdx', '```python\n#| id: demo\n#| ref: step-size\nprint(1)\n```');
    expect(() => createReferenceRegistry([page('target.mdx'), cell], config)).toThrow(
      /content\/docs\/cell.mdx:3:9.*Duplicate reference.*root.*target.mdx:4:3/u
    );
  });

  it('resolves within a locale, uses fragments on the same page, and follows moves', () => {
    const en = page('target.mdx');
    const ja = page('ja/target.mdx');
    const registry = createReferenceRegistry([en, ja], config);
    expect(resolveReference('oxref:step-size', en, registry, config)).toBe('#ox-ref-step-size');
    expect(resolveReference('oxref:step-size', page('ja/referrer.mdx'), registry, config)).toBe(
      '/manual/ja/target/#ox-ref-step-size'
    );
    const moved = page('moved.mdx');
    expect(
      resolveReference('oxref:step-size', page('referrer.mdx'), createReferenceRegistry([moved], config), config)
    ).toBe('/manual/moved/#ox-ref-step-size');
    expect(() =>
      resolveReference('oxref:step-size', page('ja/referrer.mdx'), createReferenceRegistry([en], config), config, {
        line: 9,
        column: 2
      })
    ).toThrow('content/docs/ja/referrer.mdx:9:2 Unresolved reference "step-size" in locale "ja"');
  });

  it.each(['oxref:step-size?query', 'oxref:step-size#fragment', 'oxref:Bad', 'oxref:'])(
    'rejects %s at the link location',
    (url) => {
      expect(() => resolveReference(url, page('referrer.mdx'), new Map(), config, { line: 3, column: 5 })).toThrow(
        'content/docs/referrer.mdx:3:5'
      );
    }
  );
});

describe('Markdown and heading transforms', () => {
  it.each(['md', 'mdx'])('rewrites only actual links and definitions in %s', async (extension) => {
    const source =
      '[inline](oxref:step-size)\n\n[reference][target]\n\n[target]: oxref:step-size\n\n`[code](oxref:missing)`\n\n```text\n[code](oxref:missing)\n```\n\n$[a](oxref:missing)$\n\n$$\n[a](oxref:missing)\n$$\n\n<a href="oxref:missing">raw</a>\n';
    const parsed = parseCellsFromMarkdown(source, `referrer.${extension}`);
    const target = page('target.mdx');
    const state = {
      page: page(`referrer.${extension}`, source),
      registry: createReferenceRegistry([target], config),
      config
    };
    const references = { page: vi.fn(async () => state) };
    const before = JSON.stringify(parsed.tree);
    await remarkReferences({ references })(parsed.tree, { path: `/repo/referrer.${extension}` });
    const after = JSON.stringify(parsed.tree);
    expect(after).toBe(before.replaceAll('"url":"oxref:step-size"', '"url":"/manual/target/#ox-ref-step-size"'));
    expect(references.page).toHaveBeenCalledWith(`/repo/referrer.${extension}`, true);
  });

  it('ignores JSX attributes and leaves failed transforms untouched', async () => {
    const source = '<Demo href="oxref:missing" />\n\n[ok](oxref:step-size) [bad](oxref:missing)';
    const { tree } = parseCellsFromMarkdown(source, 'page.mdx');
    const before = structuredClone(tree);
    const references = {
      page: async () => ({
        page: page('page.mdx'),
        registry: createReferenceRegistry([page('target.mdx')], config),
        config
      })
    };
    await expect(remarkReferences({ references })(tree, { path: '/page.mdx' })).rejects.toThrow(
      'Unresolved reference "missing"'
    );
    expect(tree).toEqual(before);
    await remarkReferences({ references })(tree, {});
    await remarkReferences({ references: { page: async () => undefined } })(tree, { path: '/outside.mdx' });
  });

  it('uses Astro heading slugs for Unicode, duplicate headings, and existing IDs', async () => {
    const heading = (text, id) => ({
      type: 'element',
      tagName: 'h2',
      properties: id ? { id } : {},
      children: [{ type: 'text', value: text }]
    });
    const tree = { type: 'root', children: [heading('日本語'), heading('日本語'), heading('Existing', 'custom')] };
    const target = page(
      'headings.mdx',
      '---\nreferences:\n  first: 日本語\n  second: 日本語-1\n  existing: custom\n---\n'
    );
    const references = { page: async () => ({ page: target }) };
    await rehypeReferences({ references })(tree, { path: '/headings.mdx', history: ['/headings.mdx'], data: {} });
    expect(tree.children.map((node) => node.properties.id)).toEqual([
      'ox-ref-first',
      '日本語',
      'ox-ref-second',
      '日本語-1',
      'ox-ref-existing',
      'custom'
    ]);
    expect(tree.children[0].tagName).toBe('span');
  });

  it('lists available slugs when a heading target is missing', async () => {
    const references = { page: async () => ({ page: page('headings.mdx') }) };
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'h2', properties: {}, children: [{ type: 'text', value: 'Different heading' }] }
      ]
    };
    await expect(
      rehypeReferences({ references })(tree, { path: '/headings.mdx', history: ['/headings.mdx'], data: {} })
    ).rejects.toThrow(
      'content/docs/headings.mdx:4:3 references.step-size: Heading slug "choosing-the-step-size" does not exist. Available slugs: "different-heading"'
    );
    await rehypeReferences({ references })(tree, {});
    await rehypeReferences({ references: { page: async () => undefined } })(tree, { path: '/outside.mdx' });
  });
});

describe('reference snapshots and development invalidation', () => {
  it('shares one immutable snapshot and distinguishes reference edits from runtime edits', async () => {
    const { paths, file } = await fixture();
    const before = await readGenerationSnapshot({ paths });
    const generation = { current: () => ({ snapshot: before }) };
    const references = createReferences({ paths, generation });
    references.configure(config);
    const state = await references.page(file, true);
    expect(state.page).toEqual(before.pages[0]);
    expect(await references.page('/outside.mdx')).toBeUndefined();
    expect(Object.isFrozen(before.pages[0].references)).toBe(true);
    await writeFile(file, targetSource + '\nUnrelated prose.\n');
    const prose = await readGenerationSnapshot({ paths });
    expect(prose.referenceId).toBe(before.referenceId);
    await writeFile(
      file,
      targetSource.replaceAll('choosing-the-step-size', 'new-heading').replace('Choosing the step size', 'New heading')
    );
    const after = await readGenerationSnapshot({ paths });
    expect(after.generationId).toBe(before.generationId);
    expect(after.referenceId).not.toBe(before.referenceId);
    await expect(assertGenerationSnapshot(before, { paths })).rejects.toThrow('content/docs/target.mdx');
  });

  it('invalidates loaded consumers across environments after a target moves', async () => {
    const { paths, file } = await fixture();
    const references = createReferences({ paths });
    references.configure(config);
    const consumer = path.join(paths.docsDir, 'referrer.mdx');
    await writeFile(consumer, '[target](oxref:step-size)');
    await references.page(consumer, true);
    const watcher = new EventEmitter();
    watcher.add = vi.fn();
    const module = {};
    const moduleGraph = { getModulesByFile: vi.fn(() => new Set([module])), invalidateModule: vi.fn() };
    const server = {
      watcher,
      environments: { ssr: { moduleGraph } },
      ws: { send: vi.fn() },
      httpServer: new EventEmitter()
    };
    references.vitePlugin().configureServer(server);
    await references.current();
    const moved = path.join(paths.docsDir, 'moved.mdx');
    await rename(file, moved);
    watcher.emit('all', 'unlink', file);
    watcher.emit('all', 'add', moved);
    await vi.waitFor(() => expect(server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' }));
    expect(moduleGraph.getModulesByFile).toHaveBeenCalledWith(consumer);
    expect(moduleGraph.invalidateModule).toHaveBeenCalledWith(module);
    const state = await references.page(consumer);
    expect(resolveReference('oxref:step-size', state.page, state.registry, state.config)).toBe(
      '/manual/moved/#ox-ref-step-size'
    );
    server.ws.send.mockClear();
    watcher.emit('all', 'change', '/outside.mdx');
    watcher.emit('all', 'change', path.join(paths.docsDir, 'image.png'));
    await writeFile(moved, targetSource + '\nMore prose.');
    watcher.emit('all', 'change', moved);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(server.ws.send).not.toHaveBeenCalled();
    await writeFile(moved, targetSource.replace('step-size:', 'Bad:'));
    watcher.emit('all', 'change', moved);
    await vi.waitFor(() => expect(server.ws.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    server.ws.send.mockClear();
    await writeFile(moved, targetSource);
    watcher.emit('all', 'change', moved);
    await vi.waitFor(() => expect(server.ws.send).toHaveBeenCalledWith({ type: 'full-reload' }));
    server.httpServer.emit('close');
    expect(watcher.listenerCount('all')).toBe(0);
  });
});
