import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'htlc-tron',
    root: import.meta.dirname,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
