import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const sourceConditions = [
  'ferry-source',
  'module',
  'browser',
  'development|production',
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: sourceConditions,
  },
  ssr: {
    resolve: {
      conditions: sourceConditions,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Testnet lab only: lets a temporary cloudflared tunnel reach the dev server.
    allowedHosts: true,
    // Same-origin path to the local solver so a tunnel or phone needs no CORS or second URL.
    proxy: {
      '/solver': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/solver/, ''),
      },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    allowedHosts: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
