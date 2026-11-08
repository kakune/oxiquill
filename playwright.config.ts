import { defineConfig, devices } from '@playwright/test';

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumExecutablePath ? { launchOptions: { executablePath: chromiumExecutablePath } } : {})
      }
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],
  webServer: [
    {
      command: 'node tests/e2e/page-grouping-server.mjs',
      env: { ASTRO_PREVIEW_BACKGROUND: '0' },
      url: 'http://127.0.0.1:4325/grouped/',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'node tests/e2e/locale-routing-server.mjs',
      env: { ASTRO_PREVIEW_BACKGROUND: '0' },
      url: 'http://127.0.0.1:4326/localized/',
      timeout: 120_000,
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'pnpm exec vite --config tests/fixtures/rust-registry/vite.config.mjs --host 127.0.0.1',
      url: 'http://127.0.0.1:4324/registry-base/',
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'pnpm --dir examples/docs-site exec astro preview --ignore-lock --host 127.0.0.1 --port 4322',
      env: { ASTRO_PREVIEW_BACKGROUND: '0' },
      url: 'http://127.0.0.1:4322',
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'pnpm exec vite --config tests/fixtures/chart-gallery/vite.config.ts --host 127.0.0.1',
      url: 'http://127.0.0.1:4323',
      reuseExistingServer: !process.env.CI
    }
  ],
  use: {
    baseURL: 'http://127.0.0.1:4322',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});
