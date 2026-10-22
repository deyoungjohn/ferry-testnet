import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const packageConfigs = readdirSync(new URL('./packages', import.meta.url))
  .map((name) => `packages/${name}`)
  .filter((path) => existsSync(`${root}${path}/vitest.config.ts`));

export default defineConfig({
  test: {
    projects: [
      ...packageConfigs.map((path) => `${path}/vitest.config.ts`),
      {
        resolve: { conditions: ['ferry-source'] },
        test: {
          name: 'default-node',
          environment: 'node',
          include: [
            'packages/**/*.{test,spec}.{ts,tsx,js,mjs}',
            'test/**/*.test.mjs',
          ],
          exclude: [
            ...configDefaults.exclude,
            ...packageConfigs.map((path) => `${path}/**`),
            '**/dist/**',
            '**/build/**',
            '**/e2e/**',
          ],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: { lines: 95 },
    },
  },
});
