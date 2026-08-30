import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = path.join(repositoryRoot, 'packages/oxiquill');
const packageReadme = await readFile(path.join(packageRoot, 'README.md'), 'utf8');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-package-'));

try {
  const staleFile = path.join(packageRoot, 'dist/accidental.txt');
  await mkdir(path.dirname(staleFile), { recursive: true });
  await writeFile(staleFile, 'must not be packed');
  await mkdir(path.join(temporaryRoot, 'first'));
  await mkdir(path.join(temporaryRoot, 'second'));

  const first = pack(path.join(temporaryRoot, 'first'));
  const second = pack(path.join(temporaryRoot, 'second'));
  assert.equal(first.integrity, second.integrity, 'identical sources must produce identical tarballs');

  const actualFiles = first.files.map(({ path: filePath }) => filePath).sort();
  const expectedFiles = await expectedPackageFiles();
  assert.deepEqual(actualFiles, expectedFiles);
  assert.ok(!actualFiles.includes('dist/accidental.txt'), 'prepack must remove stale output');
  assert.ok(actualFiles.every((filePath) => path.basename(filePath) !== 'AGENTS.md'));
  assert.ok(actualFiles.every((filePath) => !filePath.startsWith('src/')));
  assert.ok(
    actualFiles.every(
      (filePath) => !filePath.endsWith('.ts') || filePath.endsWith('.d.ts') || filePath.endsWith('.d.mts')
    )
  );
  assert.ok(actualFiles.every((filePath) => !filePath.endsWith('.tsx')));

  for (const requiredText of [
    'pnpm dlx oxiquill init',
    'npm install oxiquill',
    'oxiquill preview',
    'https://kakune.github.io/oxiquill/reference/package-api/',
    'https://github.com/kakune/oxiquill/security/policy',
    'MIT License or the Apache License, Version 2.0'
  ]) {
    assert.ok(packageReadme.includes(requiredText), `npm package README is missing ${requiredText}`);
  }

  const cliPath = path.join(packageRoot, 'dist/cli/index.mjs');
  assert.ok((await readFile(cliPath, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(cliPath)).mode & 0o111, 0o111, 'the built CLI must be executable');
    assert.equal(first.files.find(({ path: filePath }) => filePath === 'dist/cli/index.mjs')?.mode, 0o755);
  }

  await assertExportTargetsArePacked(actualFiles);
  console.log(`Verified ${actualFiles.length} deterministic files in the oxiquill npm tarball.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function pack(destination) {
  const npmArgs = ['pack', '--json', '--silent', '--pack-destination', destination];
  const isWindows = process.platform === 'win32';
  const executable = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = isWindows ? ['/d', '/s', '/c', 'npm.cmd', ...npmArgs] : npmArgs;
  const result = spawnSync(executable, args, {
    cwd: packageRoot,
    encoding: 'utf8'
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const [packed] = JSON.parse(result.stdout);
  return packed;
}

async function expectedPackageFiles() {
  const sourceRoot = path.join(packageRoot, 'src');
  const sourceFiles = await listFiles(sourceRoot);
  const compiledFiles = sourceFiles.flatMap((filePath) => {
    const relativePath = normalizePath(path.relative(sourceRoot, filePath));
    if (relativePath.endsWith('.mjs')) {
      return [`dist/${relativePath}`, `dist/${relativePath.slice(0, -4)}.d.mts`];
    }
    if (relativePath.endsWith('.tsx')) {
      return [`dist/${relativePath.slice(0, -4)}.js`, `dist/${relativePath.slice(0, -4)}.d.ts`];
    }
    if (relativePath.endsWith('.ts') && !relativePath.endsWith('.d.ts')) {
      return [`dist/${relativePath.slice(0, -3)}.js`, `dist/${relativePath.slice(0, -3)}.d.ts`];
    }
    return [];
  });
  const licenseDataRoot = path.join(sourceRoot, 'generator/license-data');
  const licenseDataFiles = (await listFiles(licenseDataRoot)).map(
    (filePath) => `dist/generator/license-data/${normalizePath(path.relative(licenseDataRoot, filePath))}`
  );
  const runtimeDataRoot = path.join(sourceRoot, 'generator/runtime-data');
  const runtimeDataFiles = (await listFiles(runtimeDataRoot)).map(
    (filePath) => `dist/generator/runtime-data/${normalizePath(path.relative(runtimeDataRoot, filePath))}`
  );
  const copiedFiles = [
    'dist/components/starlight/PageFrame.astro',
    'dist/env.d.ts',
    'dist/styles/custom.css',
    'dist/styles/katex.css',
    'dist/tsconfigs/strict.json'
  ];

  return [
    'LICENSE-APACHE',
    'LICENSE-MIT',
    'README.md',
    'package.json',
    ...compiledFiles,
    ...copiedFiles,
    ...licenseDataFiles,
    ...runtimeDataFiles
  ].sort();
}

async function assertExportTargetsArePacked(files) {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const targets = [packageJson.types, ...collectExportTargets(packageJson.exports), ...Object.values(packageJson.bin)];

  targets.forEach((target) => {
    assert.ok(files.includes(target.replace(/^\.\//u, '')), `export target ${target} is missing from the tarball`);
  });
}

function collectExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectExportTargets);
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : entry.isFile() ? [entryPath] : [];
    })
  );
  return files.flat().sort();
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}
