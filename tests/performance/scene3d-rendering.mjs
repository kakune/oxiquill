import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const destination = process.argv[2] ?? 'test-results/scene3d-rendering.json';
const server = await createServer({
  configFile: 'tests/fixtures/chart-gallery/vite.config.ts',
  server: { host: '127.0.0.1', port: 4339, strictPort: true },
  logLevel: 'error'
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}
  );
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:4339/scene3d.html');
  await page.waitForFunction(() => typeof window.benchmarkScene === 'function');
  const measurements = [];
  for (const count of [4, 1000, 10000]) {
    const samples = [];
    for (let run = 0; run < 6; run++) {
      const sample = await page.evaluate((count) => window.benchmarkScene(count), count);
      if (run > 0) samples.push(sample);
    }
    measurements.push({ count, samples });
  }
  assert.deepEqual(errors, [], 'Browser errors invalidate measurements');
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(
    destination,
    JSON.stringify(
      {
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: true,
        date: new Date().toISOString(),
        node: process.version,
        browser: browser.version(),
        cpu: os.cpus()[0]?.model,
        platform: `${os.platform()} ${os.arch()}`,
        viewport: [1000, 900],
        canvas: [720, 360],
        deviceScaleFactor: 1,
        throttling: 'none',
        warmups: 1,
        runs: 5,
        measurements
      },
      null,
      2
    ) + '\n'
  );
  console.log(`Scene3d measurements written to ${destination}`);
} finally {
  await browser?.close();
  await server.close();
}
