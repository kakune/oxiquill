import { chmod, cp, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const assetFiles = [
  ['src/components/starlight/PageFrame.astro', 'dist/components/starlight/PageFrame.astro'],
  ['src/env.d.ts', 'dist/env.d.ts'],
  ['src/styles/custom.css', 'dist/styles/custom.css'],
  ['src/styles/katex.css', 'dist/styles/katex.css'],
  ['tsconfigs/strict.json', 'dist/tsconfigs/strict.json']
];

await Promise.all(
  assetFiles.map(async ([source, target]) => {
    const targetPath = path.join(packageRoot, target);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(path.join(packageRoot, source), targetPath);
  })
);

await cp(path.join(packageRoot, 'src/generator/license-data'), path.join(packageRoot, 'dist/generator/license-data'), {
  recursive: true
});
await cp(path.join(packageRoot, 'src/generator/runtime-data'), path.join(packageRoot, 'dist/generator/runtime-data'), {
  recursive: true
});
await chmod(path.join(packageRoot, 'dist/cli/index.mjs'), 0o755);
