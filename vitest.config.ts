import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.{test,spec}.{ts,tsx,js,mjs}'],
    exclude: [
      ...configDefaults.exclude,
      '**/dist/**',
      '**/build/**',
      '**/target/**',
      '**/e2e/**',
      '**/playwright/**',
    ],
  },
});
