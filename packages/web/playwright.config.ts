import { defineConfig, devices } from '@playwright/test';

// Dedicated port: never share a server (or its env files) with a developer's `pnpm dev` on 5173.
const e2ePort = 4179;
const baseURL = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'recover/**',
  outputDir: 'test-results/playwright',
  fullyParallel: true,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --port ${e2ePort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    // Shell variables win over .env files: always test the mock stack.
    env: {
      VITE_REOWN_PROJECT_ID: '',
      VITE_SOLVER_URL: '',
      VITE_SOLVER_SIGNING_ADDRESS: '',
      VITE_USE_MOCKS: '',
    },
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
