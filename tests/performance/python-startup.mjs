import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const runs = Number(argument('--runs', '5'));
assert.ok(Number.isInteger(runs) && runs >= 5, 'Measure at least five runs per condition');
const base = argument('--base', '/oxiquill/');
const site = path.resolve(argument('--site', 'examples/docs-site/dist'));
const destination = path.resolve(argument('--output', 'test-results/python-startup.json'));
const label = argument('--label', 'measurement');
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg'
};
const cached = new Map();
const server = createServer((request, response) => {
  void (async () => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(base)) {
      response.writeHead(404).end();
      return;
    }
    let file = path.resolve(site, pathname.slice(base.length));
    if (file !== site && !file.startsWith(site + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    if (!cached.has(file)) {
      const bytes = await readFile(file);
      cached.set(file, { bytes, gzip: gzipSync(bytes), type: mime[path.extname(file)] ?? 'application/octet-stream' });
    }
    const asset = cached.get(file);
    const gzip = /gzip/u.test(request.headers['accept-encoding'] ?? '');
    response.writeHead(200, {
      'Content-Type': asset.type,
      'Cache-Control': 'public, max-age=600',
      Vary: 'Accept-Encoding',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {})
    });
    response.end(gzip ? asset.gzip : asset.bytes);
  })().catch(() => response.writeHead(404).end());
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {})
});
const samples = [];

async function timingEntries(scope) {
  return scope.evaluate(() => ({
    timeOrigin: performance.timeOrigin,
    entries: performance
      .getEntries()
      .filter((entry) => entry.name.startsWith('oxiquill:') || entry.entryType === 'resource')
      .map((entry) => entry.toJSON())
  }));
}

async function measure(page, example, condition, run) {
  const cell = page.getByTestId(`cell-${example.id}`);
  await cell.scrollIntoViewIfNeeded();
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-cell-id="${id}"]`)?.closest('astro-island')?.hasAttribute('ssr'),
    example.id
  );
  const previous =
    condition === 'repeat' ? await page.evaluate(() => globalThis.__pythonBenchmark.responses.length) : 0;
  const trigger = await page.evaluate(() => performance.now());
  if (example.button) await cell.getByRole('button', { name: 'Run', exact: true }).click();
  else if (condition === 'repeat') await cell.getByLabel('label', { exact: true }).fill(`repeat-${run}`);
  await page.waitForFunction(
    ({ previous, id }) => {
      const observation = globalThis.__pythonBenchmark;
      return (
        observation.responses.length > previous &&
        performance.getEntriesByName(`oxiquill:output-rendered:${id}`).length > 0 &&
        document.querySelector(`[data-cell-id="${id}"] .doc-cell__output-region`)?.getAttribute('aria-busy') === 'false'
      );
    },
    { previous, id: example.id },
    { timeout: 180_000 }
  );
  const main = await timingEntries(page);
  const workers = await Promise.all(
    page
      .workers()
      .filter((worker) => worker.url().includes('python-worker'))
      .map(timingEntries)
  );
  const observed = await page.evaluate(() => globalThis.__pythonBenchmark);
  const rendered = main.entries.find((entry) => entry.name === `oxiquill:output-rendered:${example.id}`);
  const response = observed.responses.at(-1);
  assert.equal(response.ok, true);
  const sample = {
    example: example.page,
    condition,
    run,
    triggerMs: trigger,
    outputMs: rendered.startTime,
    latencyMs: condition === 'repeat' ? rendered.startTime - trigger : rendered.startTime,
    renderMs: main.timeOrigin + rendered.startTime - response.at,
    main,
    workers,
    observed
  };
  samples.push(sample);
  console.log(`${example.page} ${condition} ${run}: ${sample.latencyMs.toFixed(1)} ms`);
}

try {
  for (const example of [
    { page: 'features/interactive-cells/', id: 'features__interactive-cells__python-controls', button: false },
    { page: 'features/rich-output/', id: 'features__rich-output__python-rich-outputs', button: true }
  ]) {
    for (let run = 1; run <= runs; run += 1) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'no-preference'
      });
      const page = await context.newPage();
      await page.addInitScript((cellId) => {
        globalThis.__pythonBenchmark = { requests: [], responses: [] };
        const observed = globalThis.__pythonBenchmark;
        const seen = new WeakSet();
        const ids = new Set();
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function (message, ...rest) {
          if (!seen.has(this)) {
            seen.add(this);
            this.addEventListener('message', (event) => {
              if (ids.has(event.data.requestId) && (event.data.result || event.data.ok === false))
                observed.responses.push({
                  requestId: event.data.requestId,
                  at: performance.timeOrigin + performance.now(),
                  ok: event.data.ok
                });
            });
          }
          if (message.cellId === cellId && message.type !== 'prepare') {
            ids.add(message.requestId);
            observed.requests.push({ requestId: message.requestId, at: performance.timeOrigin + performance.now() });
          }
          return Reflect.apply(post, this, [message, ...rest]);
        };
      }, example.id);
      await page.goto(origin + base + example.page, { waitUntil: 'domcontentloaded' });
      await measure(page, example, 'fresh', run);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await measure(page, example, 'reload', run);
      await measure(page, example, 'repeat', run);
      await context.close();
    }
  }
  const medians = Object.fromEntries(
    [...new Set(samples.map((sample) => `${sample.example}:${sample.condition}`))].map((key) => {
      const values = samples
        .filter((sample) => `${sample.example}:${sample.condition}` === key)
        .map((sample) => sample.latencyMs)
        .sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      return [key, values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2];
    })
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    JSON.stringify(
      {
        label,
        date: new Date().toISOString(),
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
        browser: browser.version(),
        hardware: {
          platform: os.platform(),
          cpu: os.cpus()[0]?.model,
          parallelism: os.availableParallelism(),
          memoryBytes: os.totalmem()
        },
        network: { origin: 'loopback', gzip: true, cacheMaxAgeSeconds: 600, throttling: false },
        base,
        runs,
        medians,
        samples
      },
      null,
      2
    ) + '\n'
  );
  console.log(JSON.stringify(medians, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
