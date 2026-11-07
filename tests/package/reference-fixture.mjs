import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function assertPackedReferences({ consumerRoot, build, testWasm }) {
  const configPath = path.join(consumerRoot, 'astro.config.mjs');
  const original = await readFile(configPath, 'utf8');
  const docs = path.join(consumerRoot, 'content/docs');
  const directories = ['reference-fixtures', 'ja/reference-fixtures'];
  const referrer = '[heading](oxref:packed-heading)\n\n[cell][demo]\n\n[demo]: oxref:packed-cell\n';
  const target = (locale, edited = false) =>
    [
      '---',
      'title: Stable target',
      ...(locale ? [`slug: ja/reference-${edited ? 'edited' : 'custom'}`] : []),
      'references:',
      `  packed-heading: ${edited ? 'edited-heading' : '日本語-1'}`,
      '---',
      '',
      '## 日本語',
      '',
      edited ? '## Edited *heading*' : '## 日本語',
      '',
      '```rust',
      '//| id: demo',
      '//| ref: packed-cell',
      '//| crates: []',
      'println!("stable reference");',
      '```',
      '',
      '[same page](oxref:packed-heading)',
      `[generated cell](#doc-cell-${locale ? 'ja__' : ''}reference-fixtures__${edited ? 'moved' : 'original__index'}__demo-title)`,
      ''
    ].join('\n');

  try {
    await writeFile(
      configPath,
      original
        .replace('framework: { starlight },', "framework: { starlight },\n  base: '/references/',")
        .replace(
          'disable404Route: true',
          "disable404Route: true, defaultLocale: 'root', locales: { root: { lang: 'en', label: 'English' }, ja: { lang: 'ja', label: '日本語' } }"
        )
    );
    for (const directory of directories) {
      await mkdir(path.join(docs, directory, 'original'), { recursive: true });
      await writeFile(path.join(docs, directory, 'links.mdx'), `---\ntitle: References\n---\n\n${referrer}`);
      await writeFile(path.join(docs, directory, 'original/index.mdx'), target(directory.startsWith('ja/')));
    }
    build();
    await check(false);
    for (const directory of directories) {
      await rename(path.join(docs, directory, 'original/index.mdx'), path.join(docs, directory, 'moved.mdx'));
      await writeFile(path.join(docs, directory, 'moved.mdx'), target(directory.startsWith('ja/'), true));
    }
    build();
    await check(true);
    testWasm();
  } finally {
    await writeFile(configPath, original);
    await Promise.all(directories.map((directory) => rm(path.join(docs, directory), { force: true, recursive: true })));
  }

  async function check(edited) {
    for (const directory of directories) {
      const locale = directory.startsWith('ja/');
      const route = locale
        ? `ja/reference-${edited ? 'edited' : 'custom'}`
        : `reference-fixtures/${edited ? 'moved' : 'original'}`;
      const links = await readFile(path.join(consumerRoot, 'dist', directory, 'links/index.html'), 'utf8');
      assert.ok(
        links.includes(`href="/references/${route}/#ox-ref-packed-heading"`),
        'heading link must follow the target route'
      );
      assert.ok(
        links.includes(`href="/references/${route}/#ox-ref-packed-cell"`),
        'cell definition must follow the target route'
      );
      const html = await readFile(path.join(consumerRoot, 'dist', route, 'index.html'), 'utf8');
      assert.ok(html.includes('id="ox-ref-packed-heading"'));
      assert.ok(html.includes('id="ox-ref-packed-cell"'));
      assert.ok(html.includes(`id="${edited ? 'edited-heading' : '日本語-1'}"`), 'original heading slug must remain');
      assert.ok(html.includes('href="#ox-ref-packed-heading"'), 'same-page references must use fragments');
      assert.equal(
        await readFile(path.join(docs, directory, 'links.mdx'), 'utf8'),
        `---\ntitle: References\n---\n\n${referrer}`,
        'referring source must stay unchanged'
      );
    }
  }
}
