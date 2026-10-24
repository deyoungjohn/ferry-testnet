import { describe, it, expect } from 'vitest';
import * as libauth from '@bitauth/libauth';
import { mintTokens } from '../src/mint-tokens.js';

describe('mint-tokens safety checks', () => {
  const dummyWif = libauth.encodePrivateKeyWif(
    new Uint8Array(32).fill(0x01),
    'testnet',
  );

  it('refuses to run when TPUSD_CATEGORY is present in environment without --force', async () => {
    const envContent = `SOLVER_BCH_WIF=${dummyWif}\nTPUSD_CATEGORY=ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac\n`;
    await expect(mintTokens({ envContent, force: false })).rejects.toThrow(
      /Refusing to mint tokens: TPUSD_CATEGORY or TMUSD_CATEGORY is already defined in environment/,
    );
  });

  it('refuses to run when TMUSD_CATEGORY is present in environment without --force', async () => {
    const envContent = `SOLVER_BCH_WIF=${dummyWif}\nTMUSD_CATEGORY=c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d\n`;
    await expect(mintTokens({ envContent, force: false })).rejects.toThrow(
      /Refusing to mint tokens: TPUSD_CATEGORY or TMUSD_CATEGORY is already defined in environment/,
    );
  });

  it('refuses to run when solver wallet already holds token UTXOs without --force', async () => {
    const envContent = `SOLVER_BCH_WIF=${dummyWif}\n`;
    const mockFulcrum = {
      connect: async () => {},
      listUnspent: async () => [
        {
          height: 300000,
          tx_hash:
            '1111111111111111111111111111111111111111111111111111111111111111',
          tx_pos: 0,
          value: 3000,
          token_data: {
            category:
              'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
            amount: '10000000',
          },
        },
      ],
      broadcast: async () => 'txid',
      close: () => {},
    };

    await expect(
      mintTokens({
        envContent,
        force: false,
        fulcrumClient: mockFulcrum,
      }),
    ).rejects.toThrow(
      /Refusing to mint tokens: solver wallet already holds 1 token UTXO/,
    );
  });

  it('bypasses existing token UTXO check when force: true is specified', async () => {
    const envContent = `SOLVER_BCH_WIF=${dummyWif}\n`;
    const mockFulcrum = {
      connect: async () => {},
      listUnspent: async () => [
        {
          height: 300000,
          tx_hash:
            '1111111111111111111111111111111111111111111111111111111111111111',
          tx_pos: 1, // Not pos 0, so it will fail on genesis selection after passing the safety guard
          value: 3000,
          token_data: {
            category:
              'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
            amount: '10000000',
          },
        },
      ],
      broadcast: async () => 'txid',
      close: () => {},
    };

    // When force is true, it passes the token UTXO guard and proceeds to genesis UTXO check
    await expect(
      mintTokens({
        envContent,
        force: true,
        fulcrumClient: mockFulcrum,
      }),
    ).rejects.toThrow(/No UTXO with tx_pos === 0 available for token genesis/);
  });
});
