import { defineConfig, devices } from '@playwright/test';

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const firefoxExecutablePath = process.env.PLAYWRIGHT_FIREFOX_EXECUTABLE_PATH?.trim();
const webkitExecutablePath = process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH?.trim();

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
      use: {
        ...devices['Desktop Firefox'],
        ...(firefoxExecutablePath ? { launchOptions: { executablePath: firefoxExecutablePath } } : {})
      }
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        ...(webkitExecutablePath ? { launchOptions: { executablePath: webkitExecutablePath } } : {})
      }
    }
  ],
  webServer: [
    {
      command: 'pnpm --dir examples/docs-site exec astro preview --host 127.0.0.1 --port 4322 --ignore-lock',
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
