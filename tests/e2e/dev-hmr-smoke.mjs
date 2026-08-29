import { chromium, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  const port = await availablePort();
  const runtime = startProcess(
    'runtime',
    process.execPath,
    [path.join(tempRoot, 'packages/oxiquill/src/generator/watch-doc-runtime.mjs'), '--skip-initial'],
    tempSiteRoot
  );
  await waitForOutput(runtime, '[runtime] watching MDX and Rust sources', 60_000);

  startProcess(
    'astro',
    process.execPath,
    [
      path.join(tempRoot, 'packages/oxiquill/src/cli/index.mjs'),
      'dev:astro',
      '--host',
      '127.0.0.1',
      '--port',
      String(port)
    ],
    tempSiteRoot
  );
  await waitForHttp(`http://127.0.0.1:${port}/features/interactive-cells/`, 60_000);

  browser = await chromium.launch({
    ...(chromiumExecutablePath ? { executablePath: chromiumExecutablePath } : {}),
    args: ['--disable-setuid-sandbox', '--no-sandbox']
  });
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    console.log(`[browser:pageerror] ${error.message}`);
  });
  await page.goto(`http://127.0.0.1:${port}/features/interactive-cells/`);

  const cell = page.getByTestId('cell-features__interactive-cells__python-controls');
  const source = cell.getByTestId('cell-source');
  const output = cell.getByTestId('run-output');
  await expect(source).toContainText('values = [', { timeout: 45_000 });

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
    await expect(source).toContainText('values = [10, 20, 30, 40]');
    await expect(output).toContainText('SAMPLE: mean = 75.0');
    await page.waitForTimeout(250);
  }

  console.log(`Dev HMR source refresh verified at http://127.0.0.1:${port}/features/interactive-cells/`);
} finally {
  if (browser) await browser.close();
  await stopChildren();
  rmSync(tempRoot, { force: true, recursive: true });
}

function copyWorkspace(sourceRoot, targetRoot) {
  const ignored = new Set(['.astro', '.git', 'coverage', 'dist', 'node_modules', 'target', 'test-results']);

  cpSync(sourceRoot, targetRoot, {
    dereference: false,
    filter(sourcePath) {
      const relativePath = path.relative(sourceRoot, sourcePath);
      if (!relativePath) return true;

      return relativePath.split(path.sep).every((segment) => !ignored.has(segment));
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
    env: { ...process.env, NODE_PATH: path.join(tempRoot, 'packages/oxiquill/node_modules') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  children.add(child);

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => process.stdout.write(prefixLines(label, chunk)));
  child.stderr.on('data', (chunk) => process.stderr.write(prefixLines(label, chunk)));
  child.on('exit', () => children.delete(child));

  return child;
}

async function runCommand(label, command, args, cwd) {
  const child = startProcess(label, command, args, cwd);

  await new Promise((resolve, reject) => {
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${label} exited with ${signal ?? code}`));
      }
    });
    child.on('error', reject);
  });
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(?<=\n)/)
    .map((line) => (line.trim() ? `[${label}] ${line}` : line))
    .join('');
}

function stopProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForOutput(child, expected, timeoutMs) {
  let buffered = '';

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for output: ${expected}`));
    }, timeoutMs);

    const onData = (chunk) => {
      buffered += String(chunk);
      if (buffered.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Process exited before "${expected}": ${signal ?? code}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
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
  await Promise.all(
    Array.from(
      children,
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }

          const timeout = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) stopProcessGroup(child, 'SIGKILL');
          }, 5_000);
          timeout.unref();

          child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
          stopProcessGroup(child, 'SIGTERM');
        })
    )
  );
}
