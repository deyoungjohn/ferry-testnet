import type { PersistedOrder } from '../orders/store';
import type { ChainLock } from './chain';

export interface ActivityEntry {
  readonly key: string;
  readonly createdAt: number;
  readonly direction: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
  /** Present when this browser saved the order (carries the BCH side). */
  readonly order: PersistedOrder | null;
  /** Present when the chain shows a lock for this user (any device). */
  readonly chain: ChainLock | null;
}

/** Merge the browser journal with locks read from the chain, matched by hash lock. */
export function mergeActivity(
  orders: readonly PersistedOrder[],
  locks: readonly ChainLock[],
): ActivityEntry[] {
  const byHashLock = new Map<string, ChainLock>();
  for (const lock of locks) byHashLock.set(lock.hashLock.toLowerCase(), lock);

  const entries: ActivityEntry[] = [];
  const used = new Set<string>();
  for (const order of orders) {
    const hashLock = order.terms.hashLock.toLowerCase();
    const chain = byHashLock.get(hashLock) ?? null;
    if (chain) used.add(hashLock);
    entries.push({
      key: order.orderId,
      createdAt: order.createdAt,
      direction: order.terms.direction,
      order,
      chain,
    });
  }
  for (const lock of locks) {
    const hashLock = lock.hashLock.toLowerCase();
    if (used.has(hashLock)) continue;
    entries.push({
      key: lock.id,
      createdAt: lock.lockedAt,
      direction: lock.role === 'sender' ? 'COUNTER_TO_BCH' : 'BCH_TO_COUNTER',
      order: null,
      chain: lock,
    });
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}
