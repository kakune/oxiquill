import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../packages/oxiquill/dist/cli/commands.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { cargoEnvironment } from '../../packages/oxiquill/dist/generator/doc-runtime/compiler-cache.mjs';
import { runCommandWithCapturedOutput } from '../../packages/oxiquill/dist/generator/doc-runtime/toolchain-preflight.mjs';
import { prepareLinkedFixture, pageGroupingRoot } from './page-grouping-fixture.mjs';

// The helper workspace lock carries semver-compatible alternatives of the
// runtime-pinned serde and syn, plus dev-only packages (num, helper-tests) that
// never reach the generated crates (#217).
const root = await prepareLinkedFixture(fileURLToPath(new URL('../fixtures/helper-lock/', import.meta.url)));
const manifestFile = path.join(root, 'crates/typed-helper/Cargo.toml');
const lockFile = path.join(root, 'crates/Cargo.lock');
const [originalManifest, originalLock] = await Promise.all([
  readFile(manifestFile, 'utf8'),
  readFile(lockFile, 'utf8')
]);
const events = async (args) => {
  const lines = [];
  await runCli([...args, '--format', 'json'], { cwd: root, log: (line) => lines.push(JSON.parse(line)) });
  assert.equal(lines.at(-1).exitStatus, 0);
  return lines;
};
try {
  await cp(path.join(pageGroupingRoot, '.cache'), path.join(root, '.cache'), { recursive: true }).catch(() => {});
  await runCli(['clean'], { cwd: root, log: () => {} });
  await events(['build']);
  const paths = createOxiquillPaths({ workspaceRoot: root });
  const lockPath = path.join(paths.rustCellsDir, 'Cargo.lock');
  const lock = await readFile(lockPath, 'utf8');
  assert.match(lock, /name = "serde"\nversion = "1\.0\.229"/u);
  assert.doesNotMatch(lock, /version = "1\.0\.228"/u);
  for (const absent of ['num', 'num-traits', 'autocfg', 'helper-tests'])
    assert.doesNotMatch(lock, new RegExp(`name = "${absent}"\\n`, 'u'), `${absent} must not reach the generated lock`);

  // Cargo leaves the resolved lock unchanged and accepts it with --locked.
  const options = { cwd: root, env: cargoEnvironment({ paths }) };
  const metadata = ['metadata', '--format-version', '1', '--offline', '--manifest-path'];
  await runCommandWithCapturedOutput('cargo', [...metadata, path.join(paths.rustCellsDir, 'Cargo.toml')], options);
  assert.equal(await readFile(lockPath, 'utf8'), lock);
  await runCommandWithCapturedOutput(
    'cargo',
    [...metadata, path.join(paths.rustCellsDir, 'Cargo.toml'), '--locked'],
    options
  );

  // Changing only dev-dependencies never rebuilds a module.
  await writeFile(manifestFile, originalManifest.replace('num = "0.4"', 'num = "0.4.3"\ncriterion = "0.5"'));
  await writeFile(lockFile, originalLock.replace('name = "num"\nversion = "0.4.3"', 'name = "num"\nversion = "0.4.4"'));
  const rebuilt = (await events(['docgen', '--wasm', 'build'])).filter(
    (event) => event.type === 'plan' && event.module && event.target === 'public' && event.action === 'build'
  );
  assert.deepEqual(rebuilt, []);
  console.log('Helper workspace locks with dev-only and diverging packages resolve and build with page grouping.');
} finally {
  await writeFile(manifestFile, originalManifest);
  await writeFile(lockFile, originalLock);
}
