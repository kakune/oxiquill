import { lstat, mkdir, realpath, symlink, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const pageGroupingRoot = fileURLToPath(new URL('../fixtures/page-grouping/', import.meta.url));

export async function preparePageGroupingFixture() {
  return prepareLinkedFixture(pageGroupingRoot);
}

// Fixture sites reuse the docs site's installed Starlight, Astro, and linked Oxiquill package.
export async function prepareLinkedFixture(fixtureRoot) {
  const dependencies = path.join(fixtureRoot, 'node_modules');
  const source = fileURLToPath(new URL('../../examples/docs-site/node_modules/', import.meta.url));
  try {
    if ((await lstat(dependencies)).isSymbolicLink() && (await realpath(dependencies)) === (await realpath(source)))
      await unlink(dependencies);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  for (const name of ['@astrojs/starlight', 'astro', 'oxiquill']) {
    const target = path.join(dependencies, name);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      await lstat(target);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await symlink(path.join(source, name), target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  return fixtureRoot;
}

// Writes a minimal Oxiquill project configuration; OXIQUILL_FIXTURE_GROUPING
// selects the grouping, and `custom` groups by top-level docs directory.
export async function writeFixtureProject(root, { title = 'Fixture' } = {}) {
  await mkdir(path.join(root, 'content/docs'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"private":true,"type":"module"}\n');
  await writeFile(
    path.join(root, 'astro.config.mjs'),
    [
      "import starlight from '@astrojs/starlight';",
      "import { defineOxiquillConfig } from 'oxiquill/astro';",
      '',
      "const grouping = process.env.OXIQUILL_FIXTURE_GROUPING ?? 'page';",
      '',
      'export default defineOxiquillConfig({',
      '  framework: { starlight },',
      "  site: 'https://example.com',",
      `  title: ${JSON.stringify(title)},`,
      "  vite: { ssr: { noExternal: ['@astrojs/starlight'] } },",
      "  rust: { grouping: grouping === 'custom' ? ({ path }) => path.split('/')[0] : grouping },",
      '  starlight: { disable404Route: true }',
      '});',
      ''
    ].join('\n')
  );
  await writeFile(
    path.join(root, 'content.config.ts'),
    [
      "import { defineCollection } from 'astro:content';",
      "import { docsLoader } from '@astrojs/starlight/loaders';",
      "import { docsSchema } from '@astrojs/starlight/schema';",
      "import { createOxiquillCollections } from 'oxiquill/content';",
      '',
      'export const collections = createOxiquillCollections({ defineCollection, docsLoader, docsSchema });',
      ''
    ].join('\n')
  );
  return root;
}
