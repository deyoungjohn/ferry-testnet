import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodePrivateKeyWif,
  encodeLockingBytecodeP2pkh,
  hash160,
  lockingBytecodeToCashAddress,
  secp256k1,
} from '@bitauth/libauth';
import { defineConfig, devices } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(webRoot, '../..');
const envPath = path.join(repoRoot, '.env.local');
const envText = fs.readFileSync(envPath, 'utf8');

function env(key: string): string {
  const match = envText.match(new RegExp(`^${key}=([^\\r\\n]+)$`, 'm'));
  if (!match?.[1]) throw new Error(`Missing ${key} in .env.local`);
  return match[1].trim();
}

function bchAddress(wif: string): string {
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('Invalid USER_BCH_WIF');
  const pubkey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pubkey === 'string') throw new Error(pubkey);
  const locking = encodeLockingBytecodeP2pkh(hash160(pubkey));
  const encoded = lockingBytecodeToCashAddress({
    bytecode: locking,
    prefix: 'bchtest',
    tokenSupport: true,
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

const solverSigner = privateKeyToAccount(
  env('SOLVER_EVM_PRIVATE_KEY') as `0x${string}`,
);
const solverBch = bchAddress(env('SOLVER_BCH_WIF'));
const port = Number(process.env.PLAYWRIGHT_LIVE_PORT ?? 5181);
const baseURL = `http://127.0.0.1:${port.toString()}`;

export default defineConfig({
  testDir: './e2e/live',
  outputDir: 'test-results/playwright-live',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'pnpm --filter @ferry/solver exec tsx --env-file=../../.env.local src/main.ts',
      url: 'http://127.0.0.1:8790/v1/health',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: '8790',
        HOST: '127.0.0.1',
        DATABASE_PATH: ':memory:',
      },
    },
    {
      command: `pnpm exec vite --port ${port.toString()} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_SOLVER_URL: 'http://127.0.0.1:8790',
        VITE_SOLVER_SIGNING_ADDRESS: solverSigner.address,
        VITE_SOLVER_BCH_ADDRESS: solverBch,
        VITE_REOWN_PROJECT_ID: '',
        VITE_USE_MOCKS: '',
      },
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});
