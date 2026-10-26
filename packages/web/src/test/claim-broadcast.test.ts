import { describe, expect, it, vi } from 'vitest';
import {
  broadcastClaimIdempotent,
  isAlreadyBroadcastError,
} from '../lib/bch/claim-broadcast';

const MESSAGES = [
  'transaction already in block chain',
  'txn-already-known',
  'transaction already known',
  'bad-txns-inputs-missingorspent',
  'txn-mempool-conflict',
  'missing inputs',
  'input already spent',
] as const;

describe('idempotent BCH claim broadcast', () => {
  it('treats each already-known/duplicate answer as success', async () => {
    for (const message of MESSAGES) {
      const broadcast = vi.fn(async () => {
        throw new Error(message);
      });
      await expect(
        broadcastClaimIdempotent(broadcast, '00', `tx-${message}`),
      ).resolves.toEqual({ txid: `tx-${message}`, already: true });
      expect(isAlreadyBroadcastError(new Error(message))).toBe(true);
    }
  });

  it('returns the broadcast txid on first success', async () => {
    await expect(
      broadcastClaimIdempotent(async () => 'real-txid', '00', 'expected'),
    ).resolves.toEqual({ txid: 'real-txid', already: false });
  });

  it('rethrows unrelated broadcast failures', async () => {
    await expect(
      broadcastClaimIdempotent(
        async () => {
          throw new Error('connection dropped');
        },
        '00',
        'expected',
      ),
    ).rejects.toThrow(/connection dropped/);
  });
});
