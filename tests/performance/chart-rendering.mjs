import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer, build } from 'vite';
import { chartGalleryConfig } from '../fixtures/chart-gallery/vite.config.ts';

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const source = path.resolve(argument('--source', '.'));
const runs = Number(argument('--runs', '5'));
assert.ok(Number.isInteger(runs) && runs >= 5, 'Measure at least five runs per condition');
const destination = argument('--output', 'test-results/chart-rendering.json');
const config = chartGalleryConfig(source);
const root = fileURLToPath(new URL('../fixtures/chart-performance', import.meta.url));
const outDir = path.resolve('test-results/chart-performance-site');
// Compile once so Vite development transforms and dependency discovery do not enter the samples.
await build({ ...config, configFile: false, root, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
const server = await createServer({
  configFile: false,
  root: outDir,
  server: { port: 4338, strictPort: true },
  logLevel: 'error'
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {})
  });
  const measurements = [];
  for (const kind of ['line', 'scatter']) {
    for (const count of [1000, 10000, 100000]) {
      for (const progressiveDisabled of count === 100000 && kind === 'scatter' ? [false, true] : [false]) {
        const samples = [];
        for (let run = 0; run <= runs; run++) {
          const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 });
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto('http://127.0.0.1:4338');
          await page.waitForFunction(() => Boolean(window.chartBenchmark));
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Performance.enable');
          const metrics = async () =>
            Object.fromEntries(
              (await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value])
            );
          const before = await metrics();
          const sample = await page.evaluate(
            ({ kind, count, progressiveDisabled }) => window.chartBenchmark(kind, count, progressiveDisabled),
            { kind, count, progressiveDisabled }
          );
          const after = await metrics();
          assert.deepEqual(errors, [], 'Browser errors invalidate performance samples');
          if (run) samples.push({ ...sample, mainThreadMs: (after.TaskDuration - before.TaskDuration) * 1000 });
          await page.close();
        }
        measurements.push({ kind, count, progressiveDisabled, samples });
        console.log(`Measured ${kind} ${count} points${progressiveDisabled ? ' without progressive' : ''}`);
      }
    }
  }
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4338');
  await page.waitForFunction(() => Boolean(window.chartStyleCost));
  const barStyle = await page.evaluate(() => window.chartStyleCost());
  await page.close();
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    JSON.stringify(
      {
        revision: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        label: argument('--label', 'working-tree'),
        date: new Date().toISOString(),
        node: process.version,
        browser: browser.version(),
        cpu: os.cpus()[0].model,
        cpus: os.availableParallelism(),
        memoryBytes: os.totalmem(),
        platform: `${os.platform()} ${os.arch()}`,
        viewport: [900, 700],
        chart: [720, 360],
        deviceScaleFactor: 1,
        throttling: 'none',
        warmups: 1,
        runs,
        measurements,
        barStyle
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Chart measurements written to ${destination}`);
} finally {
  await browser?.close();
  await server.close();
}
