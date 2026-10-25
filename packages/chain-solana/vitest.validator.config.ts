import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['ferry-source'] },
  ssr: {
    resolve: { conditions: ['ferry-source', 'node', 'module', 'development'] },
  },
  test: {
    name: 'chain-solana-validator',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.validator.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
