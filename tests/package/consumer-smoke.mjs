import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
const packageApiSource = `
import { defineOxiquillConfig as defineRootConfig, oxiquillIntegration } from 'oxiquill';
import { defineOxiquillConfig } from 'oxiquill/astro';
import { createOxiquillCollections } from 'oxiquill/content';
import InteractiveCell from 'oxiquill/runtime/InteractiveCell';
import MermaidDiagram from 'oxiquill/runtime/MermaidDiagram';
import type { CellManifest } from 'oxiquill/runtime/types';

const cell = {} as CellManifest;
void [
  defineRootConfig,
  oxiquillIntegration,
  defineOxiquillConfig,
  createOxiquillCollections,
  InteractiveCell,
  MermaidDiagram,
  cell
];
`;

try {
  const packResult = run('npm', ['pack', '--json', '--silent', '--pack-destination', temporaryRoot], packageRoot, true);
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
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  await rename(path.join(consumerRoot, 'tsconfig.json'), tsconfigPath);
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
  tsconfig.exclude = ['state cache', 'helper crates/target', 'built site', 'static files/oxiquill assets'];
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  await writeFile(
    path.join(consumerRoot, 'astro.config.mjs'),
    [
      "import starlight from '@astrojs/starlight';",
      "import { defineOxiquillConfig } from 'oxiquill/astro';",
      "import { fileURLToPath } from 'node:url';",
      '',
      "const projectRoot = fileURLToPath(new URL('./site root/', import.meta.url));",
      '',
      'export default defineOxiquillConfig({',
      '  framework: { starlight },',
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
    ].join('\n')
  );
  const packageJsonPath = path.join(consumerRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const tarballReference = path.relative(consumerRoot, tarballPath).split(path.sep).join('/');
  packageJson.dependencies.oxiquill = `file:${tarballReference}`;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(path.join(projectRoot, 'package-api.ts'), packageApiSource);
  await appendFile(
    path.join(projectRoot, 'written docs/index.mdx'),
    [
      '',
      '```rust',
      '//| id: package-rust',
      '//| crates: []',
      'println!("packed consumer");',
      '```',
      '',
      '```python',
      '#| id: package-python',
      '#| packages: [numpy]',
      'print("packed consumer")',
      '```',
      ''
    ].join('\n')
  );

  run(packageManager, ['install'], consumerRoot);
  run(
    packageManager,
    packageManager === 'npm' ? ['exec', '--', 'oxiquill', 'help'] : ['exec', 'oxiquill', 'help'],
    consumerRoot
  );
  run(
    'node',
    ['--input-type=module', '--eval', "await import('oxiquill'); await import('oxiquill/astro');"],
    consumerRoot
  );
  run(packageManager, ['run', 'check'], consumerRoot);
  run(packageManager, ['run', 'wasm:dev'], consumerRoot);
  run(packageManager, ['run', 'build'], consumerRoot);

  const pyodidePublicDir = path.join(projectRoot, 'static files/oxiquill assets/python runtime');
  const pyodideBuildDir = path.join(projectRoot, 'built site/oxiquill assets/python runtime');
  const lockFile = JSON.parse(await readFile(path.join(pyodidePublicDir, 'pyodide-lock.json'), 'utf8'));
  const numpyWheel = lockFile.packages.numpy.file_name;
  const requiredPyodideFiles = [
    'pyodide.mjs',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
    numpyWheel
  ];

  for (const fileName of requiredPyodideFiles) {
    await assertFile(path.join(pyodidePublicDir, fileName));
    await assertFile(path.join(pyodideBuildDir, fileName));
  }

  const publicLicenses = path.join(projectRoot, 'static files/oxiquill assets/legal notices');
  const builtLicenses = path.join(projectRoot, 'built site/oxiquill assets/legal notices');
  for (const fileName of ['LICENSE-MIT', 'LICENSE-APACHE', 'THIRD_PARTY_LICENSES.txt']) {
    await assertFile(path.join(publicLicenses, fileName));
    await assertFile(path.join(builtLicenses, fileName));
  }
  const bundleReportPath = path.join(projectRoot, 'built site/oxiquill/bundle-report.json');
  const bundleReport = JSON.parse(await readFile(bundleReportPath, 'utf8'));
  assert.equal(bundleReport.limitBytes, 650 * 1024);
  assert.ok(bundleReport.chunks.length > 0, 'packed consumer bundle report contains no chunks');
  assert.ok(
    bundleReport.chunks.every((chunk) => chunk.uncompressedBytes <= bundleReport.limitBytes),
    'packed consumer emitted an oversized client chunk'
  );
  await assertFile(path.join(projectRoot, 'static files/oxiquill assets/rust runtime/doc_rust_cells_bg.wasm'));
  await assertFile(path.join(projectRoot, 'state cache/generated runtime/cells.json'));

  run(packageManager, ['run', 'clean'], consumerRoot);
  await assertMissing(path.join(projectRoot, 'state cache'));
  await assertMissing(path.join(projectRoot, 'built site'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets'));
  await assertFile(path.join(projectRoot, 'static files/favicon.svg'));
  await assertFile(path.join(projectRoot, 'written docs/index.mdx'));
  console.log(`Packed consumer smoke test passed with ${packageManager} in ${consumerRoot}.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

function run(command, args, cwd, capture = false) {
  const isWindowsPackageManager = process.platform === 'win32' && (command === 'npm' || command === 'pnpm');
  const executable = isWindowsPackageManager ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const commandArgs = isWindowsPackageManager ? ['/d', '/s', '/c', `${command}.cmd`, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  assert.ifError(result.error);
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
