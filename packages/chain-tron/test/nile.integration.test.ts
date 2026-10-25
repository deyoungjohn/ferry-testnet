import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { TronChainAdapter } from '../src/index.js';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const envPaths = [
    resolve(__dirname, '../../../.env.local'),
    resolve('/workspace/projects/ferry-app/.env.local'),
  ];
  for (const p of envPaths) {
    if (existsSync(p)) {
      const lines = readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && v.length > 0) {
          env[k.trim()] = v.join('=').trim();
        }
      }
      break;
    }
  }
  return env;
}

const env = loadEnv();
const hasNileKeys = Boolean(env.USER_TRON_KEY && env.SOLVER_TRON_KEY);

describe.skipIf(!hasNileKeys || process.env.RUN_NILE_TESTS !== 'true')(
  'TronChainAdapter (Nile Live Integration)',
  () => {
    let adapter: TronChainAdapter;

    beforeAll(() => {
      adapter = new TronChainAdapter({
        network: 'nile',
        privateKey: env.SOLVER_TRON_KEY,
      });
    });

    it('queries live on-chain lock state on Nile', async () => {
      // S-10 lockId verified on Nile:
      // 0x0a471cacfde5b29bb4d602f99b3cfc2774d955879f096af9eae9d5fe2fea81ca
      const lockId =
        '0x0a471cacfde5b29bb4d602f99b3cfc2774d955879f096af9eae9d5fe2fea81ca';
      const lockState = await adapter.getLock(lockId);

      expect(lockState.status).toBe('claimed');
      if (lockState.status === 'claimed') {
        expect(lockState.asset.symbol).toBe('USDT');
        expect(lockState.amount).toBe(5000000n);
      }
    });

    it('verifies finality on live Nile transactions', async () => {
      const claimTx = {
        chain: 'tron' as const,
        txId: '5e641269d721f30570883145c8b854c745865c90a499abc84e8d0e1fc55bab67',
      };

      const fastFinal = await adapter.isFinal(claimTx, 'fast');
      expect(fastFinal).toBe(true);

      const safeFinal = await adapter.isFinal(claimTx, 'safe');
      expect(safeFinal).toBe(true);
    });
  },
);
