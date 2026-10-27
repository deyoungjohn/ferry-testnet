import { describe, expect, it } from 'vitest';
import {
  describeShortfall,
  formatBch,
  friendlyBuildError,
  summarizeBalance,
} from '../lib/bch/balance';

const CATEGORY = `0x${'ab'.repeat(32)}`;
const utxo = (satoshis: bigint, amount?: bigint) => ({
  txid: '00'.repeat(32),
  vout: 0,
  satoshis,
  lockingBytecode: '0x76a9' as const,
  ...(amount !== undefined ? { token: { category: CATEGORY, amount } } : {}),
});

describe('readable wallet balances', () => {
  it('sums the token and the satoshis', () => {
    expect(
      summarizeBalance(
        [utxo(1_000n, 188n), utxo(5_000n), utxo(800n, 12n)],
        CATEGORY,
      ),
    ).toEqual({ tokenAmount: 200n, satoshis: 6_800n });
  });

  it('says 1.88 tPUSD, not 188', () => {
    expect(
      describeShortfall(
        { tokenAmount: 188n, satoshis: 50_000n },
        { tokenAmount: 500n, carrySats: 3_000n, symbol: 'tPUSD' },
      ),
    ).toBe('You need 5.00 tPUSD but this wallet has 1.88 tPUSD.');
  });

  it('rewrites the builder error and hides the category', () => {
    const text = friendlyBuildError(
      `Insufficient token balance for category ${CATEGORY}: required 500, available 188`,
      'tPUSD',
    );
    expect(text).toBe('You need 5.00 tPUSD but this wallet has 1.88 tPUSD.');
    expect(text).not.toContain('abab');
  });

  it('formats satoshis as BCH without trailing zeros', () => {
    expect(formatBch(123_000n)).toBe('0.00123');
    expect(formatBch(100_000_000n)).toBe('1');
  });
});
