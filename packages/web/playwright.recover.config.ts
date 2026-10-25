import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/recover',
  outputDir: 'test-results/playwright-recover',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'anvil --port 8545 --chain-id 84532 --silent',
    port: 8545,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
