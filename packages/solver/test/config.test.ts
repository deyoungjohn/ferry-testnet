import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfigFromEnv } from '../src/config.js';

describe('Solver Configuration vs .env.example', () => {
  it('parses .env.example and asserts parsed values equal documented defaults', () => {
    // Find .env.example in repo root
    let dir = process.cwd();
    while (
      !fs.existsSync(path.join(dir, '.env.example')) &&
      path.dirname(dir) !== dir
    ) {
      dir = path.dirname(dir);
    }
    const envExamplePath = path.join(dir, '.env.example');
    expect(fs.existsSync(envExamplePath)).toBe(true);

    const envContent = fs.readFileSync(envExamplePath, 'utf8');
    const parsedEnv: Record<string, string> = {};

    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (value) {
          parsedEnv[key] = value;
        }
      }
    }

    // Verify key fields in .env.example
    expect(parsedEnv.NETWORK).toBe('testnet');
    expect(parsedEnv.SPREAD_BPS).toBe('40');
    expect(parsedEnv.FIXED_FEE_USD).toBe('0.05');
    expect(parsedEnv.MIN_SWAP_USD).toBe('1');
    expect(parsedEnv.MAX_SWAP_USD).toBe('50');
    expect(parsedEnv.MAX_OPEN_EXPOSURE_USD).toBe('250');
    expect(parsedEnv.ZERO_CONF_MAX_USD).toBe('25');
    expect(parsedEnv.QUOTE_TTL_S).toBe('60');
    expect(parsedEnv.PEG_TOLERANCE).toBe('0.01');
    expect(parsedEnv.EVM_CONFS).toBe('10');
    expect(parsedEnv.DSPROOF_WINDOW_MS).toBe('5000');
    expect(parsedEnv.FWD_BCH_REFUND_BLOCKS).toBe('36');
    expect(parsedEnv.FWD_EVM_DEADLINE_S).toBe('86400');
    expect(parsedEnv.BCH_CARRY_SATS).toBe('3000');
    expect(parsedEnv.BCH_MAX_FEE_SATS).toBe('1500');

    // Parse configuration from .env.example with ALLOW_DEV_KEYS=1
    const config = loadConfigFromEnv({ ...parsedEnv, ALLOW_DEV_KEYS: '1' });

    expect(config.network).toBe('testnet');
    expect(config.spreadBps).toBe(40);
    expect(config.fixedFeeUsdMicros).toBe(50000n); // $0.05
    expect(config.minSwapUsdMicros).toBe(1000000n); // $1.00
    expect(config.maxSwapUsdMicros).toBe(50000000n); // $50.00
    expect(config.maxExposureUsdMicros).toBe(250000000n); // $250.00
    expect(config.zeroConfMaxUsdMicros).toBe(25000000n); // $25.00
    expect(config.quoteTtlSeconds).toBe(60);
    expect(config.pegTolerance).toBe(0.01);
    expect(config.evmConfs).toBe(10);
    expect(config.dsproofWindowMs).toBe(5000);
    expect(config.fwdBchRefundBlocks).toBe(36);
    expect(config.fwdEvmDeadlineSeconds).toBe(86400);
    expect(config.bchCarrySats).toBe(3000n);
    expect(config.bchMaxFeeSats).toBe(1500n);

    // Network mapped values for testnet
    expect(config.bchElectrumUrls).toBe(parsedEnv.BCH_CHIPNET_ELECTRUM_URLS);
    expect(config.baseRpcUrl).toBe(parsedEnv.BASE_SEPOLIA_RPC_URL);
    expect(config.baseChainId).toBe(Number(parsedEnv.BASE_SEPOLIA_CHAIN_ID));
    expect(config.baseHtlcAddress).toBe(
      parsedEnv.BASE_SEPOLIA_FERRY_HTLC_ADDRESS,
    );
    expect(config.baseUsdcAddress).toBe(parsedEnv.BASE_SEPOLIA_USDC_ADDRESS);
    expect(config.tpusdCategory).toBe(parsedEnv.TPUSD_CATEGORY);
  });

  it('fails closed when SOLVER_EVM_PRIVATE_KEY is missing without ALLOW_DEV_KEYS=1', () => {
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'testnet',
      }),
    ).toThrowError(/ALLOW_DEV_KEYS=1/);
  });

  it('allows default dev key when ALLOW_DEV_KEYS=1 on testnet', () => {
    const cfg = loadConfigFromEnv({
      NETWORK: 'testnet',
      ALLOW_DEV_KEYS: '1',
    });
    expect(cfg.solverEvmPrivateKey).toBe(
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    );
  });

  it('strictly rejects default dev key or missing key on mainnet even with ALLOW_DEV_KEYS=1', () => {
    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        ALLOW_DEV_KEYS: '1',
      }),
    ).toThrowError(/SOLVER_EVM_PRIVATE_KEY is required on mainnet/);

    expect(() =>
      loadConfigFromEnv({
        NETWORK: 'mainnet',
        ALLOW_DEV_KEYS: '1',
        SOLVER_EVM_PRIVATE_KEY:
          '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      }),
    ).toThrowError(/Default dev private key cannot be used on mainnet/);
  });

  describe('Pay-link mock signature gating', () => {
    it('defaults allowMockPaylinkSignatures to false', () => {
      const cfg = loadConfigFromEnv({
        NETWORK: 'testnet',
        ALLOW_DEV_KEYS: '1',
      });
      expect(cfg.allowMockPaylinkSignatures).toBe(false);
    });

    it('enables allowMockPaylinkSignatures on testnet with ALLOW_MOCK_PAYLINK_SIGNATURES=1', () => {
      const cfg = loadConfigFromEnv({
        NETWORK: 'testnet',
        ALLOW_DEV_KEYS: '1',
        ALLOW_MOCK_PAYLINK_SIGNATURES: '1',
      });
      expect(cfg.allowMockPaylinkSignatures).toBe(true);
    });

    it('strictly refuses startup on mainnet when ALLOW_MOCK_PAYLINK_SIGNATURES=1 is set', () => {
      expect(() =>
        loadConfigFromEnv({
          NETWORK: 'mainnet',
          SOLVER_EVM_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          ALLOW_MOCK_PAYLINK_SIGNATURES: '1',
        }),
      ).toThrowError(
        /ALLOW_MOCK_PAYLINK_SIGNATURES is not permitted on mainnet/,
      );
    });
  });
});
