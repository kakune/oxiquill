import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProcess } from './process-output.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'oxiquill-dev-hmr-'));
const tempSiteRoot = path.join(tempRoot, 'examples/docs-site');
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const children = new Set();
let browser;

try {
  copyWorkspace(repoRoot, tempRoot);
  disableDevToolbar();
  await runCommand('install', 'pnpm', ['install', '--offline', '--frozen-lockfile', '--ignore-scripts'], tempRoot);

  await runCommand('build', 'pnpm', ['build:package'], tempRoot);

  const port = await availablePort();
  const runtime = startProcess(
    'runtime',
    process.execPath,
    [path.join(tempRoot, 'packages/oxiquill/dist/generator/watch-doc-runtime.mjs')],
    tempSiteRoot
  );
  await Promise.all([
    runtime.waitForOutput(/^\[runtime\] watching .+$/mu, 60_000),
    runtime.waitForOutput('[runtime] ready:', 300_000)
  ]);

  const astro = startProcess(
    'astro',
    process.execPath,
    [
      path.join(tempRoot, 'packages/oxiquill/dist/cli/index.mjs'),
      'dev:astro',
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    tempSiteRoot
  );
  await waitForHttp(`http://127.0.0.1:${port}/features/interactive-cells/`, 60_000, [runtime, astro]);

  browser = await chromium.launch({
    ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
    args: ['--disable-setuid-sandbox', '--no-sandbox']
  });
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      const diagnostic = `${message.text()} ${JSON.stringify(message.location())}`;
      console.log(`[browser:${message.type()}] ${diagnostic}`);
      if (message.type() === 'error') browserErrors.push(diagnostic);
    }
  });
  page.on('pageerror', (error) => {
    const diagnostic = error.stack ?? error.message;
    console.log(`[browser:pageerror] ${diagnostic}`);
    browserErrors.push(diagnostic);
  });
  await page.goto(`http://127.0.0.1:${port}/features/interactive-cells/`);

  const cell = page.getByTestId('cell-features__interactive-cells__python-controls');
  await cell.scrollIntoViewIfNeeded();
  const source = cell.getByTestId('cell-source');
  const output = cell.getByTestId('run-output');
  await expect(source).toContainText('values = [1, 2, 3, 4]', { timeout: 45_000 });
  await expect(output).toContainText('SAMPLE: mean = 7.5', { timeout: 60_000 });

  const mdxPath = path.join(tempSiteRoot, 'content/docs/features/interactive-cells.mdx');
  const before = readFileSync(mdxPath, 'utf8');
  const after = before.replace(/^values = \[[^\]]+\]$/m, 'values = [10, 20, 30, 40]');
  if (after === before) {
    throw new Error('Could not find the Python values line to mutate.');
  }
  writeFileSync(mdxPath, after);

  await expect(source).toContainText('values = [10, 20, 30, 40]', { timeout: 60_000 });
  await expect(output).toContainText('SAMPLE: mean = 75.0', { timeout: 60_000 });

  const stableUntil = Date.now() + 3_000;
  while (Date.now() < stableUntil) {
    runtime.assertRunning();
    astro.assertRunning();
    expect(browserErrors, 'Browser console and page errors').toEqual([]);
    await expect(source).toContainText('values = [10, 20, 30, 40]');
    await expect(output).toContainText('SAMPLE: mean = 75.0');
    await page.waitForTimeout(250);
  }

  expect(browserErrors, 'Browser console and page errors').toEqual([]);
  console.log(`Dev HMR source refresh verified at http://127.0.0.1:${port}/features/interactive-cells/`);
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      await stopChildren();
    } finally {
      rmSync(tempRoot, { force: true, recursive: true, maxRetries: 10, retryDelay: 250 });
    }
  }
}

function copyWorkspace(sourceRoot, targetRoot) {
  const ignored = new Set([
    '.astro',
    '.git',
    '.cache',
    '.oxiquill',
    '.codex',
    '.direnv',
    '.agents',
    '.serena',
    'coverage',
    'dist',
    'node_modules',
    'target',
    'test-results',
    'playwright-report'
  ]);

  cpSync(sourceRoot, targetRoot, {
    dereference: false,
    filter(sourcePath) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      if (!relativePath) return true;

      const segments = relativePath.split(path.sep);
      return segments.every(
        (segment, index) => !ignored.has(segment) && !(segment === 'oxiquill' && segments[index - 1] === 'public')
      );
    },
    recursive: true
  });
}

function disableDevToolbar() {
  const configPath = path.join(tempSiteRoot, 'astro.config.mjs');
  const before = readFileSync(configPath, 'utf8');
  const after = before.replace(
    'export default defineOxiquillConfig({',
    'export default defineOxiquillConfig({\n  devToolbar: { enabled: false },'
  );

  if (after === before) {
    throw new Error('Could not disable the Astro dev toolbar in the temp config.');
  }

  writeFileSync(configPath, after);
}

function startProcess(label, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: {
      ...process.env,
      // Keep Astro in our process group even when it detects an agent environment.
      ASTRO_DEV_BACKGROUND: '0',
      ASTRO_TELEMETRY_DISABLED: '1',
      NODE_PATH: path.join(tempRoot, 'packages/oxiquill/node_modules')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);

  const observed = observeProcess(child, label);
  child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(label, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(label, chunk)));
  return observed;
}

async function runCommand(label, command, args, cwd) {
  await startProcess(label, command, args, cwd).waitForExit();
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(?<=\n)/)
    .map((line) => (line.trim() ? `[${label}] ${line}` : line))
    .join('');
}

function stopProcessGroup(child, signal) {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
    return false;
  }
}

async function waitForHttp(url, timeoutMs, processes) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    processes.forEach((process) => process.assertRunning());
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Keep polling until the dev server is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function availablePort() {
  const server = createServer();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate an available TCP port.');
  }

  return address.port;
}

async function stopChildren() {
  const results = await Promise.allSettled(
    Array.from(children, async (child) => {
      if (!stopProcessGroup(child, 'SIGTERM')) return;
      const deadline = Date.now() + 5_000;
      while (stopProcessGroup(child, 0) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      stopProcessGroup(child, 'SIGKILL');
    })
  );
  const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Could not stop dev HMR process groups');
}
