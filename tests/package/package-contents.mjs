import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = path.join(repositoryRoot, 'packages/oxiquill');
const licenseDataRoot = path.join(packageRoot, 'src/generator/license-data');
const runtimeManifest = readJson('runtime-artifacts.json');
const packageOverrides = readJson('bundled-package-overrides.json');
const isWindows = process.platform === 'win32';
const executable = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args = isWindows ? ['/d', '/s', '/c', 'npm.cmd', 'pack', '--dry-run', '--json'] : ['pack', '--dry-run', '--json'];
const result = spawnSync(executable, args, {
  cwd: packageRoot,
  encoding: 'utf8'
});

assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr || result.stdout);
const [packResult] = JSON.parse(result.stdout);
const files = packResult.files.map(({ path: filePath }) => filePath).sort();
const requiredFiles = [
  'LICENSE-APACHE',
  'LICENSE-MIT',
  'README.md',
  'package.json',
  'src/generator/browser-bundle-report.mjs',
  'src/generator/license-data/bundled-package-overrides.json',
  'src/generator/license-data/runtime-artifacts.json',
  'src/generator/license-data/rust/runtime-Cargo.lock',
  'src/generator/license-notices.mjs'
];
requiredFiles.push(
  ...runtimeManifest.artifacts
    .flatMap(({ licenseFiles }) => licenseFiles)
    .map((filePath) => `src/generator/license-data/${filePath}`),
  ...packageOverrides.packages.map(({ licenseFile }) => `src/generator/license-data/${licenseFile}`)
);

new Set(requiredFiles).forEach((filePath) => {
  assert.ok(files.includes(filePath), `npm tarball is missing ${filePath}`);
});
assert.ok(
  files.every((filePath) => path.basename(filePath) !== 'AGENTS.md'),
  `npm tarball contains an internal AGENTS.md:\n${files.filter((filePath) => path.basename(filePath) === 'AGENTS.md').join('\n')}`
);

console.log(`Verified ${files.length} files in the oxiquill npm tarball.`);

function readJson(fileName) {
  return JSON.parse(readFileSync(path.join(licenseDataRoot, fileName), 'utf8'));
}
