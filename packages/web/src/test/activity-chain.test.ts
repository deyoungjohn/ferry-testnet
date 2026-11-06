import { describe, expect, it } from 'vitest';
import { scanRange, type ChainLock } from '../lib/activity/chain';
import { mergeActivity } from '../lib/activity/merge';
import type { PersistedOrder } from '../lib/orders/store';

describe('scanRange', () => {
  it('covers the whole range exactly once', async () => {
    const seen: Array<[bigint, bigint]> = [];
    await scanRange(
      async (a, b) => {
        seen.push([a, b]);
        return [];
      },
      1n,
      120_000n,
    );
    const sorted = [...seen].sort((x, y) => Number(x[0] - y[0]));
    expect(sorted[0]?.[0]).toBe(1n);
    expect(sorted.at(-1)?.[1]).toBe(120_000n);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i]![0]).toBe(sorted[i - 1]![1] + 1n);
    }
  });

  it('halves the chunk when the RPC refuses a wide range', async () => {
    let widest = 0n;
    const rows = await scanRange(
      async (a, b) => {
        if (b - a + 1n > 200n)
          throw new Error('eth_getLogs is limited to a 200 range');
        widest = b - a + 1n > widest ? b - a + 1n : widest;
        return [Number(a)];
      },
      1n,
      1_000n,
    );
    expect(widest).toBeLessThanOrEqual(200n);
    expect(rows.length).toBe(5);
  });

  it('gives up with the original error at the smallest chunk', async () => {
    await expect(
      scanRange(
        async () => {
          throw new Error('rpc down');
        },
        1n,
        1_000n,
      ),
    ).rejects.toThrow('rpc down');
  });
});

describe('mergeActivity', () => {
  const hashLock = `0x${'ab'.repeat(32)}` as const;
  const lock = (over: Partial<ChainLock> = {}): ChainLock => ({
    id: `0x${'01'.repeat(32)}`,
    role: 'sender',
    token: `0x${'11'.repeat(20)}`,
    amount: 5_000_000n,
    hashLock,
    deadline: 1n,
    blockNumber: 1n,
    lockedAt: 200,
    lockTx: `0x${'aa'.repeat(32)}`,
    state: 'claimed',
    settleTx: `0x${'bb'.repeat(32)}`,
    ...over,
  });
  const order = {
    orderId: `0x${'09'.repeat(32)}`,
    createdAt: 100,
    terms: { hashLock, direction: 'COUNTER_TO_BCH' },
  } as unknown as PersistedOrder;

  it('joins a local order and a chain lock by hash lock', () => {
    const merged = mergeActivity({ bch: [], orders: [order], locks: [lock()] });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.order).toBe(order);
    expect(merged[0]?.chain?.state).toBe('claimed');
  });

  it('keeps chain-only locks, with direction from the role, newest first', () => {
    const other = lock({
      id: `0x${'02'.repeat(32)}`,
      hashLock: `0x${'cd'.repeat(32)}`,
      role: 'recipient',
      lockedAt: 300,
    });
    const merged = mergeActivity({
      bch: [],
      orders: [order],
      locks: [lock(), other],
    });
    expect(merged.map((entry) => entry.key)).toEqual([other.id, order.orderId]);
    expect(merged[0]?.direction).toBe('BCH_TO_COUNTER');
    expect(merged[0]?.order).toBeNull();
  });
});
