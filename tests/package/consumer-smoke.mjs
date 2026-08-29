import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = path.join(repositoryRoot, 'packages/oxiquill');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-consumer-'));
const consumerRoot = path.join(temporaryRoot, 'consumer');

try {
  const packResult = run('npm', ['pack', '--json', '--pack-destination', temporaryRoot], packageRoot, true);
  const [packed] = JSON.parse(packResult.stdout);
  const tarballPath = path.join(temporaryRoot, packed.filename);

  await cp(path.join(repositoryRoot, 'templates/basic'), consumerRoot, { recursive: true });
  const projectRoot = path.join(consumerRoot, 'site root');
  await mkdir(projectRoot);
  await rename(path.join(consumerRoot, 'content'), path.join(projectRoot, 'content'));
  await cp(path.join(projectRoot, 'content/docs'), path.join(projectRoot, 'written docs'), {
    recursive: true
  });
  await rename(path.join(consumerRoot, 'crates'), path.join(projectRoot, 'helper crates'));
  await rename(path.join(consumerRoot, 'public'), path.join(projectRoot, 'static files'));
  await rename(path.join(consumerRoot, 'content.config.ts'), path.join(projectRoot, 'content.config.ts'));
  await rename(path.join(consumerRoot, 'tsconfig.json'), path.join(projectRoot, 'tsconfig.json'));
  await writeFile(path.join(consumerRoot, 'astro.config.mjs'), [
    "import { defineOxiquillConfig } from 'oxiquill/astro';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const projectRoot = fileURLToPath(new URL('./site root/', import.meta.url));",
    '',
    'export default defineOxiquillConfig({',
    '  root: projectRoot,',
    "  publicDir: 'static files',",
    "  cacheDir: 'state cache',",
    "  outDir: 'built site',",
    '  paths: {',
    "    docsDir: new URL('./site root/written docs/', import.meta.url),",
    "    cratesDir: 'helper crates',",
    "    generatedDir: 'generated runtime',",
    "    publicAssetsDir: 'oxiquill assets',",
    "    haskellWasmPublicDir: 'haskell runtime',",
    "    licensesPublicDir: 'legal notices',",
    "    pyodidePublicDir: 'python runtime',",
    "    rustWasmPublicDir: 'rust runtime'",
    '  },',
    "  site: 'https://example.com',",
    "  title: 'My Docs',",
    "  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]",
    '});',
    ''
  ].join('\n'));
  const packageJson = JSON.parse(await readFile(path.join(consumerRoot, 'package.json'), 'utf8'));
  packageJson.dependencies.oxiquill = `file:${tarballPath}`;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await appendFile(path.join(projectRoot, 'written docs/index.mdx'), [
    '',
    '```rust',
    '//| id: package-smoke',
    '//| crates: []',
    'println!("packed consumer");',
    '```',
    ''
  ].join('\n'));

  run('pnpm', ['install'], consumerRoot);
  run('pnpm', ['check'], consumerRoot);
  run('pnpm', ['run', 'wasm:dev'], consumerRoot);
  run('pnpm', ['build'], consumerRoot);

  const publicLicenses = path.join(projectRoot, 'static files/oxiquill assets/legal notices');
  const builtLicenses = path.join(projectRoot, 'built site/oxiquill assets/legal notices');
  for (const fileName of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.txt']) {
    await assertFile(path.join(publicLicenses, fileName));
    await assertFile(path.join(builtLicenses, fileName));
  }
  await assertFile(path.join(projectRoot, 'static files/oxiquill assets/rust runtime/doc_rust_cells_bg.wasm'));
  await assertFile(path.join(projectRoot, 'state cache/generated runtime/cells.json'));

  run('pnpm', ['clean'], consumerRoot);
  await assertMissing(path.join(projectRoot, 'state cache'));
  await assertMissing(path.join(projectRoot, 'built site'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets'));
  await assertFile(path.join(projectRoot, 'static files/favicon.svg'));
  await assertFile(path.join(projectRoot, 'written docs/index.mdx'));
  console.log(`Packed consumer smoke test passed in ${consumerRoot}.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(command, args, cwd, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  assert.equal(result.status, 0, capture ? result.stderr || result.stdout : `${command} failed`);
  return result;
}

async function assertFile(filePath) {
  const content = await readFile(filePath);
  assert.ok(content.byteLength > 0, `${filePath} is missing or empty`);
}

async function assertMissing(filePath) {
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
}
