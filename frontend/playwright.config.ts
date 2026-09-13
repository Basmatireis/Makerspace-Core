import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const macOSChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH ??
  (process.platform === 'darwin' && existsSync(macOSChrome)
    ? macOSChrome
    : undefined);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    launchOptions: chromeExecutable
      ? { executablePath: chromeExecutable }
      : undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  ...(useExternalServer
    ? {}
    : {
        webServer: {
          command: 'pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort',
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
        },
      }),
});
