import type { PersistedOrder } from '../orders/store';
import type { BchActivityItem } from './bch';
import type { ChainLock } from './chain';

export interface ActivityEntry {
  readonly key: string;
  readonly createdAt: number;
  readonly direction: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
  /** Read from Bitcoin Cash for the user's address (the main source). */
  readonly bch: BchActivityItem | null;
  /** Saved in this browser: carries the order terms and any in-flight state. */
  readonly order: PersistedOrder | null;
  /** The counter-chain (Base) lock, joined by hash lock. */
  readonly chain: ChainLock | null;
}

function normalizeHash(hash: string): string {
  return `0x${hash.replace(/^0x/, '').toLowerCase()}`;
}

function orderHashes(order: PersistedOrder): Set<string> {
  const hashes = new Set<string>();
  for (const tx of order.transactions) hashes.add(tx.hash.toLowerCase());
  if (order.bchLockUtxo) hashes.add(order.bchLockUtxo.txid.toLowerCase());
  return hashes;
}

/**
 * Build the activity list from Bitcoin Cash first. Browser-saved orders and
 * counter-chain locks only enrich a BCH entry (matched by hash lock or shared
 * BCH transaction ids); the ones with no BCH counterpart still appear, because
 * an order in flight is not on BCH yet.
 */
export function mergeActivity(sources: {
  readonly bch: readonly BchActivityItem[];
  readonly orders: readonly PersistedOrder[];
  readonly locks: readonly ChainLock[];
}): ActivityEntry[] {
  const locksByHash = new Map<string, ChainLock>();
  for (const lock of sources.locks) {
    locksByHash.set(normalizeHash(lock.hashLock), lock);
  }
  const usedOrders = new Set<string>();
  const usedLocks = new Set<string>();
  const entries: ActivityEntry[] = [];

  function takeLock(hashLock: string | null): ChainLock | null {
    if (!hashLock) return null;
    const lock = locksByHash.get(normalizeHash(hashLock));
    if (!lock) return null;
    usedLocks.add(lock.id);
    return lock;
  }

  for (const item of sources.bch) {
    const hashLock = item.hashLock ? normalizeHash(item.hashLock) : null;
    const hashes = new Set(item.txs.map((tx) => tx.hash.toLowerCase()));
    const order =
      sources.orders.find((candidate) => {
        if (usedOrders.has(candidate.orderId)) return false;
        if (hashLock && normalizeHash(candidate.terms.hashLock) === hashLock) {
          return true;
        }
        for (const hash of orderHashes(candidate)) {
          if (hashes.has(hash)) return true;
        }
        return false;
      }) ?? null;
    if (order) usedOrders.add(order.orderId);
    const lock = takeLock(hashLock ?? (order ? order.terms.hashLock : null));
    entries.push({
      key: item.key,
      createdAt: item.time,
      direction: item.direction,
      bch: item,
      order,
      chain: lock,
    });
  }

  for (const order of sources.orders) {
    if (usedOrders.has(order.orderId)) continue;
    entries.push({
      key: order.orderId,
      createdAt: order.createdAt,
      direction: order.terms.direction,
      bch: null,
      order,
      chain: takeLock(order.terms.hashLock),
    });
  }

  for (const lock of sources.locks) {
    if (usedLocks.has(lock.id)) continue;
    entries.push({
      key: lock.id,
      createdAt: lock.lockedAt,
      direction: lock.role === 'sender' ? 'COUNTER_TO_BCH' : 'BCH_TO_COUNTER',
      bch: null,
      order: null,
      chain: lock,
    });
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt);
}
