import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import { publicViteEnv } from './env/public-env.ts';

const sourceConditions = [
  'ferry-source',
  'module',
  'browser',
  'development|production',
];

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(webRoot, '../..');

function exposeRootViteEnv(mode: string): void {
  const webEnv = loadEnv(mode, webRoot, 'VITE_');
  const rootEnv = loadEnv(mode, repoRoot, 'VITE_');
  const merged = publicViteEnv(rootEnv, webEnv);
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export default defineConfig(({ mode }) => {
  exposeRootViteEnv(mode);
  return {
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
      testTimeout: 45_000,
      css: true,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
