import { describe, expect, it, vi } from 'vitest';
import {
  ClaimSpentError,
  ClaimVerificationError,
  broadcastClaimIdempotent,
  isAmbiguousSpentError,
  isProvenBroadcastError,
} from '../lib/bch/claim-broadcast';

const PROVEN = [
  'transaction already in block chain',
  'txn-already-known',
  'transaction already known',
] as const;

const AMBIGUOUS = [
  'bad-txns-inputs-missingorspent',
  'txn-mempool-conflict',
  'missing inputs',
  'input already spent',
] as const;

const expected = 'expected-claim-txid';

describe('BCH claim broadcast proof', () => {
  it('accepts only proven already-known answers without a lookup', async () => {
    for (const message of PROVEN) {
      const transactionExists = vi.fn(async () => false);
      await expect(
        broadcastClaimIdempotent({
          broadcast: async () => {
            throw new Error(message);
          },
          transactionExists,
          txHex: '00',
          expectedTxid: expected,
        }),
      ).resolves.toEqual({ txid: expected, already: true });
      expect(transactionExists).not.toHaveBeenCalled();
      expect(isProvenBroadcastError(new Error(message))).toBe(true);
      expect(isAmbiguousSpentError(new Error(message))).toBe(false);
    }
  });

  it('accepts an ambiguous spend only when our expected claim txid exists', async () => {
    for (const message of AMBIGUOUS) {
      const transactionExists = vi.fn(
        async (txid: string) => txid === expected,
      );
      await expect(
        broadcastClaimIdempotent({
          broadcast: async () => {
            throw new Error(message);
          },
          transactionExists,
          txHex: '00',
          expectedTxid: expected,
        }),
      ).resolves.toEqual({ txid: expected, already: true });
      expect(transactionExists).toHaveBeenCalledWith(expected);
    }
  });

  it('refuses a refund/other spend when our claim txid does not exist', async () => {
    for (const message of AMBIGUOUS) {
      await expect(
        broadcastClaimIdempotent({
          broadcast: async () => {
            throw new Error(message);
          },
          transactionExists: async () => false,
          txHex: '00',
          expectedTxid: expected,
        }),
      ).rejects.toBeInstanceOf(ClaimSpentError);
    }
  });

  it('refuses to reveal the secret when the txid lookup itself fails', async () => {
    await expect(
      broadcastClaimIdempotent({
        broadcast: async () => {
          throw new Error('missing inputs');
        },
        transactionExists: async () => {
          throw new Error('electrum down');
        },
        txHex: '00',
        expectedTxid: expected,
      }),
    ).rejects.toBeInstanceOf(ClaimVerificationError);
  });

  it('rethrows unrelated broadcast failures', async () => {
    await expect(
      broadcastClaimIdempotent({
        broadcast: async () => {
          throw new Error('connection dropped');
        },
        transactionExists: async () => false,
        txHex: '00',
        expectedTxid: expected,
      }),
    ).rejects.toThrow(/connection dropped/);
  });
});
