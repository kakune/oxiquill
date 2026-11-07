import { lstat, mkdir, realpath, symlink, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const pageGroupingRoot = fileURLToPath(new URL('../fixtures/page-grouping/', import.meta.url));

export async function preparePageGroupingFixture() {
  const dependencies = path.join(pageGroupingRoot, 'node_modules');
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
  return pageGroupingRoot;
}
