import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function assertMathDependencies(packageRoot) {
  const require = createRequire(await realpath(path.join(packageRoot, 'package.json')));
  const katex = JSON.parse(await readFile(require.resolve('katex/package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.katex, katex.version, 'KaTeX must be a pinned production dependency');
  assert.equal(
    manifest.dependencies['rehype-katex'],
    undefined,
    'KaTeX markup and stylesheet must both come from the pinned KaTeX dependency'
  );
  assert.equal(manifest.exports['./styles/katex.css'], './dist/styles/katex.css');
}
