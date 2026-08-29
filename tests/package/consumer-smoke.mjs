import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
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
  const packageJson = JSON.parse(await readFile(path.join(consumerRoot, 'package.json'), 'utf8'));
  packageJson.dependencies.oxiquill = `file:${tarballPath}`;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await appendFile(path.join(consumerRoot, 'content/docs/index.mdx'), [
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

  const publicLicenses = path.join(consumerRoot, 'public/oxiquill/licenses');
  const builtLicenses = path.join(consumerRoot, 'dist/oxiquill/licenses');
  for (const fileName of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.txt']) {
    await assertFile(path.join(publicLicenses, fileName));
    await assertFile(path.join(builtLicenses, fileName));
  }
  await assertFile(path.join(consumerRoot, 'public/oxiquill/rust-wasm/doc_rust_cells_bg.wasm'));
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
