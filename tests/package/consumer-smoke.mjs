import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const supportedPythonPackages = [
  'contourpy',
  'cycler',
  'fonttools',
  'kiwisolver',
  'matplotlib',
  'numpy',
  'packaging',
  'pandas',
  'pillow',
  'pyparsing',
  'python-dateutil',
  'pytz',
  'six'
];

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

  initializePackedConsumer(packageManager, tarballPath, consumerRoot, temporaryRoot);
  const packageJsonPath = path.join(consumerRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const tarballReference = path.relative(consumerRoot, tarballPath).split(path.sep).join('/');
  packageJson.dependencies.oxiquill = `file:${tarballReference}`;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  packageJson.scripts['test:wasm'] = 'oxiquill test-wasm';
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  run(packageManager, ['install'], consumerRoot);
  const packedCliPath = path.join(consumerRoot, 'node_modules/oxiquill/dist/cli/index.mjs');
  const versionResult = run(process.execPath, [packedCliPath, '--version'], consumerRoot, true);
  assert.equal(versionResult.stdout.trim(), packed.version);
  for (const command of [
    'init',
    'dev',
    'dev:runtime',
    'dev:astro',
    'preview',
    'build',
    'check',
    'docgen',
    'clean',
    'test-rust',
    'test-rust-coverage',
    'lint-rust',
    'doc-rust',
    'test-wasm'
  ]) {
    const helpResult = run(process.execPath, [packedCliPath, command, '--help'], consumerRoot, true);
    assert.match(helpResult.stdout, new RegExp(`Usage: oxiquill ${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  }
  run(
    'node',
    ['--input-type=module', '--eval', "await import('oxiquill'); await import('oxiquill/astro');"],
    consumerRoot
  );

  const nodeOnlyEnvironment = createNodeOnlyEnvironment();
  run(process.execPath, [packedCliPath, 'check'], consumerRoot, false, nodeOnlyEnvironment);
  run(process.execPath, [packedCliPath, 'build'], consumerRoot, false, nodeOnlyEnvironment);
  run(packageManager, ['run', 'preview', '--', '--background', '--host', '127.0.0.1', '--port', '4321'], consumerRoot);
  await assertFile(path.join(consumerRoot, '.astro/preview.json'));
  stopAstroPreview(packageManager, consumerRoot);
  run(packageManager, ['run', 'clean'], consumerRoot);

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
  await writeFile(path.join(projectRoot, 'package-api.ts'), packageApiSource);
  run(
    packageManager,
    packageManager === 'npm' ? ['exec', '--', 'oxiquill', 'help'] : ['exec', 'oxiquill', 'help'],
    consumerRoot
  );
  run(process.execPath, [packedCliPath, 'check'], consumerRoot, false, nodeOnlyEnvironment);
  run(process.execPath, [packedCliPath, 'build'], consumerRoot, false, nodeOnlyEnvironment);

  await assertFile(path.join(projectRoot, 'state cache/generated runtime/cells.json'));
  await assertMissing(path.join(projectRoot, 'state cache/rust-cells'));
  await assertMissing(path.join(projectRoot, 'state cache/haskell-cells'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/python runtime'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/rust runtime'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/haskell runtime'));

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
      '#| run: autorun',
      `#| packages: [${supportedPythonPackages.join(', ')}]`,
      'import contourpy',
      'import cycler',
      'import fontTools',
      'import kiwisolver',
      'import matplotlib',
      'import numpy',
      'import packaging',
      'import pandas',
      'from PIL import Image',
      'import pyparsing',
      'import dateutil',
      'import pytz',
      'import six',
      'print("packed python imports: ok")',
      '```',
      ...(process.platform === 'win32'
        ? []
        : [
            '',
            '```haskell',
            '--| id: package-haskell',
            '--| inputs:',
            '--|   label: { type: text, label: label, value: packed-consumer }',
            'putStrLn (label ++ ": Haskell/WASI")',
            '```'
          ]),
      ''
    ].join('\n')
  );

  run(packageManager, ['run', 'check'], consumerRoot);
  run(packageManager, ['run', 'wasm:dev'], consumerRoot);
  run(packageManager, ['run', 'test:wasm'], consumerRoot);
  run(packageManager, ['run', 'build'], consumerRoot);

  const pyodidePublicDir = path.join(projectRoot, 'static files/oxiquill assets/python runtime');
  const pyodideBuildDir = path.join(projectRoot, 'built site/oxiquill assets/python runtime');
  const lockFile = JSON.parse(await readFile(path.join(pyodidePublicDir, 'pyodide-lock.json'), 'utf8'));
  const packageWheels = supportedPythonPackages.map((packageName) => lockFile.packages[packageName].file_name);
  const requiredPyodideFiles = [
    'pyodide.mjs',
    'pyodide.asm.mjs',
    'pyodide.asm.wasm',
    'python_stdlib.zip',
    'pyodide-lock.json',
    ...packageWheels
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
  if (process.platform !== 'win32') {
    await assertFile(path.join(projectRoot, 'static files/oxiquill assets/haskell runtime/doc_haskell_cells.wasm'));
  }
  for (const fileName of ['doc_rust_cells.d.ts', 'doc_rust_cells_bg.wasm.d.ts', 'package.json']) {
    await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/rust runtime', fileName));
    await assertMissing(path.join(projectRoot, 'built site/oxiquill assets/rust runtime', fileName));
  }
  await assertFile(path.join(projectRoot, 'state cache/generated runtime/cells.json'));

  if (process.env.OXIQUILL_PACKED_BROWSER === 'true') {
    await runPackedPythonBrowserSmoke({ consumerRoot, packedCliPath, projectRoot });
  }

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

async function runPackedPythonBrowserSmoke({ consumerRoot, packedCliPath, projectRoot }) {
  const port = 4_387;
  const server = spawn(process.execPath, [packedCliPath, 'preview', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: consumerRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverOutput = [];
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  let browser;

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 60_000, server, serverOutput);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {})
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'state cache/generated runtime/cells.json')));
    const pythonCell = manifest.find((cell) => cell.id.endsWith('__package-python'));
    assert.deepEqual(pythonCell?.packages, supportedPythonPackages);
    const result = await page.evaluate(
      async ({ packageNames, source }) => {
        const indexUrl = new URL('/oxiquill%20assets/python%20runtime/', location.href).href;
        const response = await fetch(new URL('pyodide.mjs', indexUrl));
        if (!response.ok) throw new Error(`Unable to load packed Pyodide module: ${response.status}.`);
        const moduleUrl = URL.createObjectURL(new Blob([await response.text()], { type: 'text/javascript' }));
        try {
          const { loadPyodide } = await import(moduleUrl);
          const pyodide = await loadPyodide({ indexURL: indexUrl });
          await pyodide.loadPackage(packageNames);
          return pyodide.runPython(source);
        } finally {
          URL.revokeObjectURL(moduleUrl);
        }
      },
      { packageNames: pythonCell.packages, source: pythonCell.source }
    );
    assert.equal(result, null);
  } finally {
    await browser?.close();
    if (!server.killed) server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
  }
}

async function waitForHttp(url, timeoutMs, server, output) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Packed preview exited before startup.\n${output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for packed preview at ${url}.\n${output.join('')}`);
}

function initializePackedConsumer(packageManager, tarballPath, target, cwd) {
  const args =
    packageManager === 'npm'
      ? ['exec', '--yes', `--package=${tarballPath}`, '--', 'oxiquill', 'init', target]
      : ['dlx', tarballPath, 'init', target];
  run(packageManager, args, cwd);
}

function stopAstroPreview(packageManager, cwd) {
  const args =
    packageManager === 'npm' ? ['exec', '--', 'astro', 'preview', 'stop'] : ['exec', 'astro', 'preview', 'stop'];
  run(packageManager, args, cwd);
}

function run(command, args, cwd, capture = false, environment = process.env) {
  const isWindowsPackageManager = process.platform === 'win32' && (command === 'npm' || command === 'pnpm');
  const executable = isWindowsPackageManager ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const commandArgs = isWindowsPackageManager ? ['/d', '/s', '/c', `${command}.cmd`, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: environment,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, capture ? result.stderr || result.stdout : `${command} failed`);
  return result;
}

function createNodeOnlyEnvironment() {
  const environment = { ...process.env };
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  environment[pathKey] = path.dirname(process.execPath);
  environment.OXIQUILL_NODE = process.execPath;
  delete environment.OXIQUILL_HASKELL_GHC;
  return environment;
}

async function assertFile(filePath) {
  const content = await readFile(filePath);
  assert.ok(content.byteLength > 0, `${filePath} is missing or empty`);
}

async function assertMissing(filePath) {
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
}
