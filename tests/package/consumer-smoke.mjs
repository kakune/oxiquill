import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { loadDocumentedConsumerConfig } from '../docs/documented-config.mjs';

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
const browserSmoke = process.argv.includes('--browser');
const consumerEnvironment = { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' };
assert.ok(
  packageManagerArgument >= 0 && (packageManager === 'npm' || packageManager === 'pnpm'),
  '--package-manager must be either "npm" or "pnpm".'
);

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageRoot = path.join(repositoryRoot, 'packages/oxiquill');
const registryMode = process.argv.includes('--registry');
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-consumer-'));
const consumerRoot = path.join(temporaryRoot, 'consumer');
const documentedConfig = await loadDocumentedConsumerConfig(repositoryRoot);
const packageApiSource = `
import starlight from '@astrojs/starlight';
import { defineOxiquillConfig as defineRootConfig, oxiquillIntegration } from 'oxiquill';
import { defineOxiquillConfig } from 'oxiquill/astro';
import type {
  OxiquillConfig,
  OxiquillFrameworkOptions,
  OxiquillIntegrationOptions,
  OxiquillMarkdownConfig,
  OxiquillPathOptions,
  OxiquillPythonOptions
} from 'oxiquill/astro';
import { createOxiquillCollections } from 'oxiquill/content';
import type { OxiquillCollections, OxiquillContentDependencies } from 'oxiquill/content';
import InteractiveCell from 'oxiquill/runtime/InteractiveCell';
import MermaidDiagram from 'oxiquill/runtime/MermaidDiagram';
import type { CellManifest } from 'oxiquill/runtime/types';

const cell = {} as CellManifest;
const paths = { downloadCacheDir: new URL('./verified downloads/', import.meta.url) } satisfies OxiquillPathOptions;
const python = { offline: true, packageMirror: new URL('https://packages.example/pyodide/') } satisfies OxiquillPythonOptions;
const publicTypes = {} as [
  OxiquillConfig,
  OxiquillFrameworkOptions,
  OxiquillIntegrationOptions,
  OxiquillPathOptions,
  OxiquillCollections<(...args: never[]) => unknown>,
  OxiquillContentDependencies<(...args: never[]) => unknown, (...args: never[]) => unknown, (...args: never[]) => unknown>
];
const markdownConfigs: OxiquillMarkdownConfig[] = [
  { syntaxHighlight: false },
  { syntaxHighlight: 'prism' },
  { syntaxHighlight: 'shiki' },
  { syntaxHighlight: { type: 'shiki', excludeLangs: ['custom'] } }
];
markdownConfigs.forEach((markdown) => defineOxiquillConfig({ framework: { starlight }, markdown }));
defineOxiquillConfig({ desktopTableOfContentsToggle: false, framework: { starlight } });
defineOxiquillConfig({
  framework: { starlight },
  markdown: {
    // @ts-expect-error Oxiquill owns the Markdown processor so required transforms cannot be bypassed.
    processor: { createRenderer: async () => ({ render: async () => ({}) }), name: 'custom', options: {} }
  }
});
void [
  defineRootConfig,
  oxiquillIntegration,
  defineOxiquillConfig,
  createOxiquillCollections,
  InteractiveCell,
  MermaidDiagram,
  cell,
  paths,
  python,
  publicTypes
];
`;

try {
  const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const expectedVersion = packageMetadata.version;
  let packageSource = `oxiquill@${expectedVersion}`;
  if (!registryMode) {
    const packResult = run(
      'npm',
      ['pack', '--json', '--silent', '--pack-destination', temporaryRoot],
      packageRoot,
      true
    );
    const [packed] = JSON.parse(packResult.stdout);
    packageSource = path.join(temporaryRoot, packed.filename);
  }

  initializeConsumer(packageManager, packageSource, consumerRoot, temporaryRoot);
  const starterConfig = {
    astro: await readFile(path.join(consumerRoot, 'astro.config.mjs'), 'utf8'),
    content: await readFile(path.join(consumerRoot, 'content.config.ts'), 'utf8')
  };
  const packageJsonPath = path.join(consumerRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  assert.equal(packageJson.dependencies.oxiquill, `^${expectedVersion}`, 'starter Oxiquill version is stale');
  assert.equal(packageJson.dependencies.preact, undefined, 'starter must not declare Preact directly');
  packageJson.dependencies.oxiquill = registryMode
    ? expectedVersion
    : `file:${path.relative(consumerRoot, packageSource).split(path.sep).join('/')}`;
  packageJson.scripts['wasm:dev'] = 'oxiquill docgen --wasm dev';
  packageJson.scripts['test:wasm'] = 'oxiquill test-wasm';
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  run(packageManager, ['install'], consumerRoot);
  await writeFile(path.join(consumerRoot, 'astro.config.mjs'), documentedConfig.astro);
  await writeFile(path.join(consumerRoot, 'content.config.ts'), documentedConfig.content);
  const installedManifest = JSON.parse(
    await readFile(path.join(consumerRoot, 'node_modules/oxiquill/package.json'), 'utf8')
  );
  for (const lifecycleHook of ['prepare', 'install', 'postinstall']) {
    assert.ok(
      !Object.hasOwn(installedManifest.scripts, lifecycleHook),
      `installed manifest must not define ${lifecycleHook}`
    );
  }
  const installedCliPath = path.join(consumerRoot, 'node_modules/oxiquill/dist/cli/index.mjs');
  const versionResult = run(process.execPath, [installedCliPath, '--version'], consumerRoot, true);
  assert.equal(versionResult.stdout.trim(), expectedVersion);
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
    const helpResult = run(process.execPath, [installedCliPath, command, '--help'], consumerRoot, true);
    assert.match(helpResult.stdout, new RegExp(`Usage: oxiquill ${command.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`));
  }
  run(
    'node',
    ['--input-type=module', '--eval', "await import('oxiquill'); await import('oxiquill/astro');"],
    consumerRoot
  );

  if (packageManager === 'pnpm') {
    await appendFile(
      path.join(consumerRoot, 'content/docs/index.mdx'),
      [
        '',
        '```mermaid',
        'flowchart TD',
        '  core --> linalg',
        '```',
        '',
        '```mermaid',
        'gantt',
        '  title Packed consumer release schedule',
        '  dateFormat YYYY-MM-DD',
        '  section Release',
        '  Fix hydration :done, fix, 2026-08-29, 1d',
        '  Publish package :publish, after fix, 1d',
        '```',
        ''
      ].join('\n')
    );
    await runInstalledDevSmoke({ browserEnabled: browserSmoke, consumerRoot });
  }

  const nodeOnlyEnvironment = createNodeOnlyEnvironment();
  run(process.execPath, [installedCliPath, 'check'], consumerRoot, false, nodeOnlyEnvironment);
  await Promise.all([
    writeFile(path.join(consumerRoot, 'astro.config.mjs'), starterConfig.astro),
    writeFile(path.join(consumerRoot, 'content.config.ts'), starterConfig.content)
  ]);
  const initialBuild = run(process.execPath, [installedCliPath, 'build'], consumerRoot, true, nodeOnlyEnvironment);
  assertNo404Warning(initialBuild);
  run(packageManager, ['run', 'preview', '--', '--background', '--host', '127.0.0.1', '--port', '4321'], consumerRoot);
  await assertFile(path.join(consumerRoot, '.astro/preview.json'));
  stopAstroPreview(packageManager, consumerRoot);
  run(packageManager, ['run', 'clean'], consumerRoot);

  const projectRoot = path.join(consumerRoot, 'site root');
  await mkdir(projectRoot);
  await rename(path.join(consumerRoot, 'content'), path.join(projectRoot, 'content'));
  await rename(path.join(consumerRoot, 'crates'), path.join(projectRoot, 'helper crates'));
  await mkdir(path.join(projectRoot, 'helper crates/packed-helper/src'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'helper crates/packed-helper/Cargo.toml'),
    ["package.name = 'packed-helper'", "package.version = '0.1.0'", "package.edition = '2024'", ''].join('\n')
  );
  await writeFile(
    path.join(projectRoot, 'helper crates/packed-helper/src/lib.rs'),
    'pub fn message() -> &\'static str { "packed consumer" }\n'
  );
  await rename(path.join(consumerRoot, 'public'), path.join(projectRoot, 'static files'));
  await rename(path.join(consumerRoot, 'content.config.ts'), path.join(projectRoot, 'content.config.ts'));
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  await rename(path.join(consumerRoot, 'tsconfig.json'), tsconfigPath);
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8'));
  tsconfig.exclude = ['state cache', 'helper crates/target', 'built site', 'static files/oxiquill assets'];
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  const astroConfigPath = path.join(consumerRoot, 'astro.config.mjs');
  await writeFile(astroConfigPath, packedAstroConfig({ offline: false }));
  await writeFile(path.join(projectRoot, 'package-api.ts'), packageApiSource);
  run(
    packageManager,
    packageManager === 'npm' ? ['exec', '--', 'oxiquill', 'help'] : ['exec', 'oxiquill', 'help'],
    consumerRoot
  );
  run(process.execPath, [installedCliPath, 'check'], consumerRoot, false, nodeOnlyEnvironment);
  run(process.execPath, [installedCliPath, 'build'], consumerRoot, false, nodeOnlyEnvironment);

  await assertFile(path.join(projectRoot, 'state cache/generated runtime/cells.json'));
  await assertMissing(path.join(projectRoot, 'state cache/rust-cells'));
  await assertMissing(path.join(projectRoot, 'state cache/haskell-cells'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/python runtime'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/rust runtime'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets/haskell runtime'));

  await appendFile(
    path.join(projectRoot, 'content/docs/index.mdx'),
    [
      '',
      '```rust',
      '//| id: package-rust',
      '//| crates: [packed-helper]',
      'println!("{}", packed_helper::message());',
      '```',
      '',
      '```python',
      '#| id: package-python',
      '#| run: autorun',
      '#| timeoutMs: 180000',
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
  const lockBytes = await readFile(path.join(pyodidePublicDir, 'pyodide-lock.json'));
  const lockFile = JSON.parse(lockBytes.toString('utf8'));
  const pyodidePackagePath = createRequire(await realpath(installedCliPath)).resolve('pyodide/package.json');
  const pyodidePackage = JSON.parse(await readFile(pyodidePackagePath, 'utf8'));
  const lockSha256 = createHash('sha256').update(lockBytes).digest('hex');
  const downloadCacheDirectory = path.join(
    projectRoot,
    '.cache/oxiquill/downloads/v1/pyodide',
    pyodidePackage.version,
    lockSha256
  );
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
    await assertFile(path.join(downloadCacheDirectory, fileName));
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

  if (browserSmoke) {
    await runInstalledBrowserSmoke({ consumerRoot, installedCliPath, projectRoot });
  }

  run(packageManager, ['run', 'clean'], consumerRoot);
  await assertMissing(path.join(projectRoot, 'state cache'));
  await assertMissing(path.join(projectRoot, 'built site'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets'));
  for (const fileName of requiredPyodideFiles) {
    await assertFile(path.join(downloadCacheDirectory, fileName));
  }

  await writeFile(astroConfigPath, packedAstroConfig({ offline: true }));
  run(process.execPath, [installedCliPath, 'docgen'], consumerRoot);
  for (const fileName of requiredPyodideFiles) {
    await assertFile(path.join(pyodidePublicDir, fileName));
  }
  run(packageManager, ['run', 'clean'], consumerRoot);
  await assertMissing(path.join(projectRoot, 'state cache'));
  await assertMissing(path.join(projectRoot, 'static files/oxiquill assets'));
  for (const fileName of requiredPyodideFiles) {
    await assertFile(path.join(downloadCacheDirectory, fileName));
  }
  await assertFile(path.join(projectRoot, 'static files/favicon.svg'));
  await assertFile(path.join(projectRoot, 'content/docs/index.mdx'));
  console.log(`Packed consumer smoke test passed with ${packageManager} in ${consumerRoot}.`);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function runInstalledBrowserSmoke({ consumerRoot, installedCliPath, projectRoot }) {
  const port = 4_387;
  const server = spawn(
    process.execPath,
    [installedCliPath, 'preview', '--background', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: consumerRoot,
      env: consumerEnvironment,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  const serverOutput = [];
  let serverError;
  let serverReady = false;
  server.stdout.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverOutput.push(String(chunk)));
  server.once('error', (error) => {
    serverError = error;
  });
  let browser;

  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, 60_000, server, serverOutput, () => serverError);
    serverReady = true;
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {})
    });
    const page = await browser.newPage();
    const pageErrors = collectPageErrors(page);
    await page.goto(`http://127.0.0.1:${port}/`);
    await assertMermaidHydration(page);
    const tableOfContentsToggle = page.locator('starlight-table-of-contents-toggle button');
    await tableOfContentsToggle.waitFor({ state: 'visible' });
    assert.equal(await tableOfContentsToggle.getAttribute('aria-expanded'), 'true');
    await tableOfContentsToggle.click();
    assert.equal(await tableOfContentsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#starlight__right-sidebar').getAttribute('inert'), '');
    assert.equal(
      await page.locator('html').getAttribute('data-table-of-contents-collapsed'),
      '',
      'packed consumer did not enable the configured desktop table-of-contents toggle'
    );
    const manifest = JSON.parse(await readFile(path.join(projectRoot, 'state cache/generated runtime/cells.json')));
    const pythonCell = manifest.find((cell) => cell.id.endsWith('__package-python'));
    assert.deepEqual(pythonCell?.packages, supportedPythonPackages);
    const python = page.getByTestId(`cell-${pythonCell.id}`);
    await python.scrollIntoViewIfNeeded();
    const pythonOutput = python.getByTestId('run-output');
    await pythonOutput.waitFor({ state: 'visible', timeout: 180_000 });
    assert.match(await pythonOutput.textContent(), /packed python imports: ok/u);

    const haskellCell = manifest.find((cell) => cell.id.endsWith('__package-haskell'));
    if (haskellCell) {
      const haskell = page.getByTestId(`cell-${haskellCell.id}`);
      await haskell.scrollIntoViewIfNeeded();
      await haskell.getByRole('button', { name: 'Run' }).click();
      const haskellOutput = haskell.getByTestId('run-output');
      await haskellOutput.waitFor({ state: 'visible', timeout: 60_000 });
      assert.match(await haskellOutput.textContent(), /packed-consumer: Haskell\/WASI/u);
    }
    assertNoPageErrors(pageErrors, 'packed production preview');
  } finally {
    await browser?.close();
    if (serverReady) stopAstroPreview(packageManager, consumerRoot);
    if (server.exitCode === null && !server.signalCode) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ]);
    }
  }
}

async function runInstalledDevSmoke({ browserEnabled, consumerRoot }) {
  const port = 4_386;
  let browser;

  try {
    run(
      packageManager,
      ['run', 'dev', '--', '--background', '--host', '127.0.0.1', '--port', String(port)],
      consumerRoot
    );
    const response = await waitForHttpResponse(`http://127.0.0.1:${port}/`, 60_000);
    const html = await response.text();

    assert.equal(response.status, 200, `packed development server returned ${response.status}`);
    assert.ok(html.includes('data-testid="mermaid-diagram"'), 'packed development response omitted Mermaid SSR markup');
    assert.ok(
      !/Cannot read properties of undefined|__H/u.test(html),
      'packed development response contained a Preact hook error'
    );

    if (browserEnabled) {
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
      browser = await chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {})
      });
      const page = await browser.newPage();
      const pageErrors = collectPageErrors(page);
      await page.goto(`http://127.0.0.1:${port}/`);
      await assertMermaidHydration(page);
      assertNoPageErrors(pageErrors, 'packed development server');
    }
  } finally {
    await browser?.close();
    stopAstroDev(packageManager, consumerRoot);
  }
}

async function assertMermaidHydration(page) {
  const diagrams = page.getByTestId('mermaid-diagram');
  await diagrams.first().waitFor({ state: 'visible', timeout: 60_000 });
  assert.equal(await diagrams.count(), 2, 'packed consumer must render the Flowchart and Gantt fixtures');
  await page.waitForFunction(
    (expectedCount) => {
      const elements = [...document.querySelectorAll('[data-testid="mermaid-diagram"]')];
      return elements.length === expectedCount && elements.every((element) => element.dataset.state === 'ready');
    },
    2,
    { timeout: 60_000 }
  );

  for (let index = 0; index < 2; index += 1) {
    const diagram = diagrams.nth(index);
    assert.equal(await diagram.getAttribute('data-state'), 'ready');
    const svg = diagram.locator('.mermaid-diagram__surface > svg');
    await svg.waitFor({ state: 'visible', timeout: 60_000 });
    assert.equal(await svg.count(), 1, `Mermaid fixture ${index + 1} did not render exactly one SVG`);
    assert.equal(
      await diagram.getByRole('alert').count(),
      0,
      `Mermaid fixture ${index + 1} rendered an error fallback`
    );
  }
}

function collectPageErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  return errors;
}

function assertNoPageErrors(errors, stage) {
  assert.equal(
    errors.length,
    0,
    `${stage} emitted page errors:\n${errors.map((error) => error.stack ?? error.message).join('\n')}`
  );
}

async function waitForHttpResponse(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for packed development server at ${url}.`);
}

async function waitForHttp(url, timeoutMs, server, output, readServerError) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const serverError = readServerError();
    if (serverError) throw serverError;
    if (server.exitCode !== null && server.exitCode !== 0) {
      throw new Error(`Packed preview launcher exited with status ${server.exitCode}.\n${output.join('')}`);
    }
    if (server.signalCode) {
      throw new Error(`Packed preview launcher exited with signal ${server.signalCode}.\n${output.join('')}`);
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

function packedAstroConfig({ offline }) {
  return [
    "import starlight from '@astrojs/starlight';",
    "import { defineOxiquillConfig } from 'oxiquill/astro';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const projectRoot = fileURLToPath(new URL('./site root/', import.meta.url));",
    '',
    'export default defineOxiquillConfig({',
    '  desktopTableOfContentsToggle: true,',
    '  framework: { starlight },',
    '  root: projectRoot,',
    "  publicDir: 'static files',",
    "  cacheDir: 'state cache',",
    "  outDir: 'built site',",
    `  python: { offline: ${offline} },`,
    '  paths: {',
    "    docsDir: new URL('./site root/content/docs/', import.meta.url),",
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
    '  starlight: { disable404Route: true },',
    "  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]",
    '});',
    ''
  ].join('\n');
}

function initializeConsumer(packageManager, packageSource, target, cwd) {
  const args =
    packageManager === 'npm'
      ? ['exec', '--yes', `--package=${packageSource}`, '--', 'oxiquill', 'init', target]
      : ['dlx', packageSource, 'init', target];
  run(packageManager, args, cwd);
}

function stopAstroPreview(packageManager, cwd) {
  const args =
    packageManager === 'npm' ? ['exec', '--', 'astro', 'preview', 'stop'] : ['exec', 'astro', 'preview', 'stop'];
  run(packageManager, args, cwd);
}

function stopAstroDev(packageManager, cwd) {
  const args = packageManager === 'npm' ? ['exec', '--', 'astro', 'dev', 'stop'] : ['exec', 'astro', 'dev', 'stop'];
  run(packageManager, args, cwd);
}

function run(command, args, cwd, capture = false, environment = consumerEnvironment) {
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
  const environment = { ...consumerEnvironment };
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  environment[pathKey] = path.dirname(process.execPath);
  environment.OXIQUILL_NODE = process.execPath;
  delete environment.OXIQUILL_HASKELL_GHC;
  return environment;
}

function assertNo404Warning(result) {
  const warning = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/u)
    .find((line) => /\bwarn(?:ing)?\b/iu.test(line) && /\b404\b/u.test(line));
  assert.equal(warning, undefined, `fresh starter build emitted a missing 404 warning: ${warning}`);
}

async function assertFile(filePath) {
  const content = await readFile(filePath);
  assert.ok(content.byteLength > 0, `${filePath} is missing or empty`);
}

async function assertMissing(filePath) {
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
}
