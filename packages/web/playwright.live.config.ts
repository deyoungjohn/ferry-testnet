import {
  decodePrivateKeyWif,
  encodeLockingBytecodeP2pkh,
  hash160,
  lockingBytecodeToCashAddress,
  secp256k1,
} from '@bitauth/libauth';
import { defineConfig, devices } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';
import { LIVE_SOLVER_URL, liveEnv } from './e2e/live/live-env';

function bchAddress(wif: string): string {
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('Invalid SOLVER_BCH_WIF');
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
  liveEnv('SOLVER_EVM_PRIVATE_KEY') as `0x${string}`,
);
const solverBch = bchAddress(liveEnv('SOLVER_BCH_WIF'));
const port = Number(process.env.PLAYWRIGHT_LIVE_PORT ?? 5181);
const baseURL = `http://127.0.0.1:${port.toString()}`;

export default defineConfig({
  testDir: './e2e/live',
  outputDir: 'test-results/playwright-live',
  fullyParallel: false,
  workers: 1,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `pnpm exec vite --port ${port.toString()} --strictPort`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_SOLVER_URL: LIVE_SOLVER_URL,
        VITE_SOLVER_SIGNING_ADDRESS: solverSigner.address,
        VITE_SOLVER_BCH_ADDRESS: solverBch,
        VITE_REOWN_PROJECT_ID: '',
        VITE_USE_MOCKS: '',
        VITE_NETWORK: 'testnet',
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
