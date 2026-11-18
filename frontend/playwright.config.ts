import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

const macOSChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chromeExecutable =
  process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH ??
  (process.platform === 'darwin' && existsSync(macOSChrome) ? macOSChrome : undefined);
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';
const useExternalServer = process.env.PLAYWRIGHT_EXTERNAL_SERVER === 'true';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  // Defaults to half the cores; lower it on a busy machine (the dev server compiles routes on demand).
  workers: process.env.PLAYWRIGHT_WORKERS ? Number(process.env.PLAYWRIGHT_WORKERS) : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  outputDir: 'test-results',
  // WebKit is opt-in (PLAYWRIGHT_WEBKIT=true, after `pnpm exec playwright install webkit`) and runs only the specs
  // that end in `.webkit.spec.ts` (Chromium runs them too); CI installs Chromium only.
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromeExecutable ? { executablePath: chromeExecutable } : undefined,
      },
    },
    ...(process.env.PLAYWRIGHT_WEBKIT === 'true'
      ? [
          {
            name: 'webkit',
            testMatch: /.*(pdf-templates|webkit).*\.spec\.ts/,
            use: {
              ...devices['Desktop Safari'],
              // For a WebKit build that is not the one this Playwright version expects (its `pw_run.sh`).
              launchOptions: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH
                ? { executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH }
                : undefined,
            },
          },
        ]
      : []),
  ],
  use: {
    baseURL,
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
