import {
  binToHex,
  decodeTransactionBCH,
  hexToBin,
  sha256,
  type Transaction,
} from '@bitauth/libauth';
import {
  internalToDisplayCategory,
  parseHtlcSpendInput,
  type HtlcSpendInfo,
} from '@ferry/htlc-bch';

/** The one thing the reader needs from an Electrum (Fulcrum) connection. */
export interface BchElectrum {
  request<T>(method: string, params: readonly unknown[]): Promise<T>;
}

export type BchActivityState = 'received' | 'locked' | 'claimed' | 'refunded';

export interface BchActivityItem {
  /** Id of the covenant funding transaction (the order's BCH lock). */
  readonly key: string;
  /** `COUNTER_TO_BCH`: the user received tokens. `BCH_TO_COUNTER`: the user locked tokens. */
  readonly direction: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
  readonly state: BchActivityState;
  /** Token base units (PUSD and MUSD use two decimals). */
  readonly tokenAmount: bigint;
  readonly category: string;
  readonly hashLock: string | null;
  /** Unix seconds of the newest transaction in the swap. */
  readonly time: number;
  readonly txs: ReadonlyArray<{
    readonly label: string;
    readonly hash: string;
  }>;
}

interface VerboseTx {
  readonly hex: string;
  readonly time?: number;
  readonly blocktime?: number;
  readonly confirmations?: number;
}

interface HistoryRow {
  readonly tx_hash: string;
  readonly height: number;
}

function scripthash(lockingBytecode: Uint8Array): string {
  return binToHex(sha256.hash(lockingBytecode).reverse());
}

function txidOf(outpointTransactionHash: Uint8Array): string {
  return binToHex(outpointTransactionHash);
}

const ROW_BATCH = 8;
const P2SH32_PREFIX = 0xaa;

function isP2sh32(bytecode: Uint8Array): boolean {
  return (
    bytecode.length === 35 &&
    bytecode[0] === P2SH32_PREFIX &&
    bytecode[1] === 0x20 &&
    bytecode[34] === 0x87
  );
}

function normalizeCategory(category: string): string {
  return category.replace(/^0x/, '').toLowerCase();
}

export interface FetchBchActivityOptions {
  readonly electrum: BchElectrum;
  /** The user's locking bytecode (hex, with or without 0x). */
  readonly userLockingBytecode: string;
  /** Token categories Ferry swaps (PUSD, MUSD), display hex. */
  readonly categories: readonly string[];
  /** How many of the newest transactions to read. */
  readonly limit: number;
  readonly nowSeconds?: number;
}

export interface BchActivityResult {
  readonly items: BchActivityItem[];
  readonly totalTransactions: number;
  readonly readTransactions: number;
}

/**
 * Rebuild a user's Ferry history from Bitcoin Cash alone. A covenant spend
 * reveals its parameters (amount, hash lock, refund height, who is paid), so
 * the claim or refund in the user's own history identifies the swap; a
 * covenant funding output the user made is followed to its spend.
 */
export async function fetchBchActivity({
  electrum,
  userLockingBytecode,
  categories,
  limit,
  nowSeconds = Math.floor(Date.now() / 1000),
}: FetchBchActivityOptions): Promise<BchActivityResult> {
  const userBytes = hexToBin(userLockingBytecode.replace(/^0x/, ''));
  const userHex = binToHex(userBytes);
  const known = new Set(categories.map(normalizeCategory));
  const cache = new Map<string, { tx: Transaction; time: number }>();

  async function load(
    txid: string,
  ): Promise<{ tx: Transaction; time: number }> {
    const cached = cache.get(txid);
    if (cached) return cached;
    const verbose = await electrum.request<VerboseTx>(
      'blockchain.transaction.get',
      [txid, true],
    );
    const decoded = decodeTransactionBCH(hexToBin(verbose.hex));
    if (typeof decoded === 'string') throw new Error(decoded);
    const loaded = {
      tx: decoded,
      time: verbose.blocktime ?? verbose.time ?? nowSeconds,
    };
    cache.set(txid, loaded);
    return loaded;
  }

  const history = await electrum.request<HistoryRow[]>(
    'blockchain.scripthash.get_history',
    [scripthash(userBytes)],
  );
  const newest = history.slice(-limit);
  const items = new Map<string, BchActivityItem>();

  function put(item: BchActivityItem): void {
    const previous = items.get(item.key);
    if (!previous) {
      items.set(item.key, item);
      return;
    }
    const seen = new Set(previous.txs.map((tx) => tx.hash));
    items.set(item.key, {
      ...item,
      hashLock: item.hashLock ?? previous.hashLock,
      time: Math.max(item.time, previous.time),
      txs: [...previous.txs, ...item.txs.filter((tx) => !seen.has(tx.hash))],
    });
  }

  async function readRow(row: HistoryRow): Promise<void> {
    const { tx, time } = await load(row.tx_hash);
    let spendsCovenant = false;
    for (const input of tx.inputs) {
      const info = parseHtlcSpendInput(input.unlockingBytecode);
      if (!info) continue;
      spendsCovenant = true;
      const category = internalToDisplayCategory(info.params.tokenCategory);
      const lockTxid = txidOf(input.outpointTransactionHash);
      const recipient = binToHex(info.params.recipientLockingBytecode);
      const refundTo = binToHex(info.params.refundLockingBytecode);
      if (info.path === 'claim' && recipient === userHex) {
        put({
          key: lockTxid,
          direction: 'COUNTER_TO_BCH',
          state: 'received',
          tokenAmount: info.params.tokenAmount,
          category,
          hashLock: binToHex(info.params.hashLock),
          time,
          txs: [
            { label: 'Solver lock', hash: lockTxid },
            { label: 'Your claim', hash: row.tx_hash },
          ],
        });
      } else if (info.path === 'refund' && refundTo === userHex) {
        put({
          key: lockTxid,
          direction: 'BCH_TO_COUNTER',
          state: 'refunded',
          tokenAmount: info.params.tokenAmount,
          category,
          hashLock: binToHex(info.params.hashLock),
          time,
          txs: [
            { label: 'Your lock', hash: lockTxid },
            { label: 'Refund', hash: row.tx_hash },
          ],
        });
      }
    }
    if (spendsCovenant) return;

    for (const [vout, output] of tx.outputs.entries()) {
      if (!isP2sh32(output.lockingBytecode) || !output.token) continue;
      const category = binToHex(output.token.category);
      if (!known.has(category)) continue;
      const covenantHistory = await electrum.request<HistoryRow[]>(
        'blockchain.scripthash.get_history',
        [scripthash(output.lockingBytecode)],
      );
      let spend: { info: HtlcSpendInfo; hash: string; time: number } | null =
        null;
      for (const other of covenantHistory) {
        if (other.tx_hash === row.tx_hash) continue;
        const loaded = await load(other.tx_hash);
        for (const input of loaded.tx.inputs) {
          if (
            txidOf(input.outpointTransactionHash) !== row.tx_hash ||
            input.outpointIndex !== vout
          ) {
            continue;
          }
          const info = parseHtlcSpendInput(input.unlockingBytecode);
          if (info) spend = { info, hash: other.tx_hash, time: loaded.time };
        }
      }
      const txs = [{ label: 'Your lock', hash: row.tx_hash }];
      if (spend) {
        txs.push({
          label: spend.info.path === 'claim' ? 'Solver claim' : 'Refund',
          hash: spend.hash,
        });
      }
      put({
        key: row.tx_hash,
        direction: 'BCH_TO_COUNTER',
        state: spend
          ? spend.info.path === 'claim'
            ? 'claimed'
            : 'refunded'
          : 'locked',
        tokenAmount: output.token.amount,
        category,
        hashLock: spend ? binToHex(spend.info.params.hashLock) : null,
        time: spend ? Math.max(time, spend.time) : time,
        txs,
      });
    }
  }

  // Fulcrum answers many requests on one socket; read a few rows at a time.
  for (let start = 0; start < newest.length; start += ROW_BATCH) {
    await Promise.all(newest.slice(start, start + ROW_BATCH).map(readRow));
  }

  return {
    items: [...items.values()].sort((a, b) => b.time - a.time),
    totalTransactions: history.length,
    readTransactions: newest.length,
  };
}
