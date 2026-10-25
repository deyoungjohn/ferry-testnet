import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: { conditions: ['ferry-source'] },
  ssr: {
    resolve: { conditions: ['ferry-source', 'node', 'module', 'development'] },
  },
  test: {
    name: 'solver',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
