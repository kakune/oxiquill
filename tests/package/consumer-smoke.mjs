import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageManagerArgument = process.argv.indexOf('--package-manager');
const packageManager = process.argv[packageManagerArgument + 1];
assert.ok(
  packageManagerArgument >= 0 && (packageManager === 'npm' || packageManager === 'pnpm'),
  '--package-manager must be either "npm" or "pnpm".'
);

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
  packageJson.dependencies.oxiquill = pathToFileURL(tarballPath).href;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  await writeFile(path.join(consumerRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await appendFile(
    path.join(consumerRoot, 'content/docs/index.mdx'),
    ['', '```rust', '//| id: package-smoke', '//| crates: []', 'println!("packed consumer");', '```', ''].join('\n')
  );

  run(packageManager, ['install'], consumerRoot);
  run(packageManager, ['run', 'check'], consumerRoot);
  run(packageManager, ['run', 'wasm:dev'], consumerRoot);
  run(packageManager, ['run', 'build'], consumerRoot);

  const publicLicenses = path.join(consumerRoot, 'public/oxiquill/licenses');
  const builtLicenses = path.join(consumerRoot, 'dist/oxiquill/licenses');
  for (const fileName of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.txt']) {
    await assertFile(path.join(publicLicenses, fileName));
    await assertFile(path.join(builtLicenses, fileName));
  }
  const bundleReportPath = path.join(consumerRoot, 'dist/oxiquill/bundle-report.json');
  const bundleReport = JSON.parse(await readFile(bundleReportPath, 'utf8'));
  assert.equal(bundleReport.limitBytes, 650 * 1024);
  assert.ok(bundleReport.chunks.length > 0, 'packed consumer bundle report contains no chunks');
  assert.ok(
    bundleReport.chunks.every((chunk) => chunk.uncompressedBytes <= bundleReport.limitBytes),
    'packed consumer emitted an oversized client chunk'
  );
  await assertFile(path.join(consumerRoot, 'public/oxiquill/rust-wasm/doc_rust_cells_bg.wasm'));
  console.log(`Packed consumer smoke test passed with ${packageManager} in ${consumerRoot}.`);
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
