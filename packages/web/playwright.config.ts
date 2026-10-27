import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 5180);
const baseURL = `http://127.0.0.1:${port.toString()}`;

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['recover/**', 'live/**'],
  outputDir: 'test-results/playwright',
  fullyParallel: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 4,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --port ${port.toString()} --strictPort`,
    url: baseURL,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_SERVER === '1',
    timeout: 120_000,
    // Shell variables win over .env files: always test the mock stack.
    env: {
      VITE_REOWN_PROJECT_ID: '',
      VITE_SOLVER_URL: '',
      VITE_SOLVER_SIGNING_ADDRESS: '',
      VITE_SOLVER_BCH_ADDRESS: '',
      VITE_BCH_ELECTRUM_URL: '',
      VITE_BCH_ELECTRUM_URL_2: '',
      VITE_USE_MOCKS: '',
      VITE_WALLET_EXTENSION_SPIKE: '1',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
