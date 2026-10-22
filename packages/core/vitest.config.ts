import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['ferry-source'] },
  test: {
    name: 'core',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
