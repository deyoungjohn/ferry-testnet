import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));
const candidates = [
  ...readdirSync(new URL('./packages', import.meta.url)).map(
    (name) => `packages/${name}`,
  ),
  'scripts',
];
const names = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
];
const packageConfigs = candidates.flatMap((path) => {
  const config = names.find((name) => existsSync(`${root}${path}/${name}`));
  return config ? [{ path, config: `${path}/${config}` }] : [];
});

export default defineConfig({
  test: {
    projects: [
      ...packageConfigs.map(({ config }) => config),
      {
        resolve: { conditions: ['ferry-source'] },
        ssr: {
          resolve: {
            conditions: ['ferry-source', 'node', 'module', 'development'],
          },
        },
        test: {
          name: 'default-node',
          environment: 'node',
          include: [
            'packages/**/*.{test,spec}.{ts,tsx,js,mjs}',
            'test/**/*.test.mjs',
            'scripts/**/*.{test,spec}.{ts,js,mjs}',
          ],
          exclude: [
            ...configDefaults.exclude,
            ...packageConfigs.map(({ path }) => `${path}/**`),
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
