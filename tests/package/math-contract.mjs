import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

export async function assertMathDependencies(packageRoot) {
  const require = createRequire(await realpath(path.join(packageRoot, 'package.json')));
  const rendererRequire = createRequire(require.resolve('rehype-katex'));
  const stylesheet = JSON.parse(await readFile(require.resolve('katex/package.json'), 'utf8'));
  const renderer = JSON.parse(await readFile(rendererRequire.resolve('katex/package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.katex, stylesheet.version, 'KaTeX CSS must be a pinned production dependency');
  assert.equal(stylesheet.version, renderer.version, 'KaTeX markup and stylesheet must use the same version');
  assert.equal(manifest.exports['./styles/katex.css'], './dist/styles/katex.css');
}
