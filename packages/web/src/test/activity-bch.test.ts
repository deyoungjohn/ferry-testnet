import {
  binToHex,
  encodeTransactionBCH,
  hashTransactionUiOrder,
  hexToBin,
  sha256,
} from '@bitauth/libauth';
import {
  buildClaimTransaction,
  buildRefundTransaction,
  deriveHtlcAddresses,
  internalToDisplayCategory,
  type BchHtlcParameters,
} from '@ferry/htlc-bch';
import { describe, expect, it } from 'vitest';
import { fetchBchActivity, type BchElectrum } from '../lib/activity/bch';
import { mergeActivity } from '../lib/activity/merge';
import type { PersistedOrder } from '../lib/orders/store';

const userBytecode = hexToBin(`76a914${'11'.repeat(20)}88ac`);
const solverBytecode = hexToBin(`76a914${'22'.repeat(20)}88ac`);
const internalCategory = hexToBin('33'.repeat(32));
const displayCategory = internalToDisplayCategory(internalCategory);

function params(
  secret: Uint8Array,
  direction: 'forward' | 'reverse',
  tokenAmount = 3700n,
): BchHtlcParameters {
  return {
    hashLock: sha256.hash(secret),
    recipientLockingBytecode:
      direction === 'forward' ? userBytecode : solverBytecode,
    refundLockingBytecode:
      direction === 'forward' ? solverBytecode : userBytecode,
    tokenCategory: internalCategory,
    tokenAmount,
    refundHeight: 330_195,
    maxFee: 1500n,
  };
}

function scripthash(bytecode: Uint8Array): string {
  return binToHex(sha256.hash(bytecode).reverse());
}

/** A tiny Fulcrum: transactions by id, history by script hash. */
class FakeChain implements BchElectrum {
  readonly txs = new Map<string, string>();
  readonly history = new Map<string, string[]>();

  add(hex: string, ...scripts: Uint8Array[]): string {
    const id = binToHex(hashTransactionUiOrder(hexToBin(hex)));
    this.txs.set(id, hex);
    for (const script of scripts) {
      const key = scripthash(script);
      this.history.set(key, [...(this.history.get(key) ?? []), id]);
    }
    return id;
  }

  async request<T>(method: string, args: readonly unknown[]): Promise<T> {
    if (method === 'blockchain.scripthash.get_history') {
      return (this.history.get(String(args[0])) ?? []).map(
        (tx_hash, index) => ({
          tx_hash,
          height: 100 + index,
        }),
      ) as T;
    }
    if (method === 'blockchain.transaction.get') {
      return {
        hex: this.txs.get(String(args[0])),
        blocktime: 1_793_000_000,
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
}

function lockTx(
  chain: FakeChain,
  p: BchHtlcParameters,
  funder: Uint8Array,
): string {
  const covenant = deriveHtlcAddresses(p, 'chipnet').lockingBytecode;
  const hex = binToHex(
    encodeTransactionBCH({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointIndex: 0,
          outpointTransactionHash: hexToBin('ee'.repeat(32)),
          sequenceNumber: 0xffffffff,
          unlockingBytecode: hexToBin('00'),
        },
      ],
      outputs: [
        {
          lockingBytecode: covenant,
          valueSatoshis: 3000n,
          token: { amount: p.tokenAmount, category: hexToBin(displayCategory) },
        },
      ],
    }),
  );
  return chain.add(hex, funder, covenant);
}

const user = binToHex(userBytecode);
const base = {
  userLockingBytecode: user,
  categories: [displayCategory],
  limit: 30,
};

describe('BCH-first activity', () => {
  it('finds a swap the user received from their claim alone', async () => {
    const secret = new Uint8Array(32).fill(9);
    const p = params(secret, 'forward');
    const chain = new FakeChain();
    const solverLock = lockTx(chain, p, solverBytecode);
    const claim = buildClaimTransaction({
      params: p,
      network: 'chipnet',
      secret,
      utxo: { txid: solverLock, vout: 0, satoshis: 3000n },
      feeSats: 500n,
    });
    chain.add(claim.txHex, userBytecode);

    const { items } = await fetchBchActivity({ electrum: chain, ...base });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: solverLock,
      direction: 'COUNTER_TO_BCH',
      state: 'received',
      tokenAmount: 3700n,
    });
    expect(items[0]?.hashLock).toBe(binToHex(p.hashLock));
    expect(items[0]?.txs.map((tx) => tx.label)).toEqual([
      'Solver lock',
      'Your claim',
    ]);
  });

  it('follows the user’s own lock to the solver’s claim', async () => {
    const secret = new Uint8Array(32).fill(5);
    const p = params(secret, 'reverse', 2900n);
    const chain = new FakeChain();
    const lock = lockTx(chain, p, userBytecode);
    const claim = buildClaimTransaction({
      params: p,
      network: 'chipnet',
      secret,
      utxo: { txid: lock, vout: 0, satoshis: 3000n },
      feeSats: 500n,
    });
    chain.add(
      claim.txHex,
      deriveHtlcAddresses(p).lockingBytecode,
      solverBytecode,
    );

    const { items } = await fetchBchActivity({ electrum: chain, ...base });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: lock,
      direction: 'BCH_TO_COUNTER',
      state: 'claimed',
      tokenAmount: 2900n,
    });
    expect(items[0]?.hashLock).toBe(binToHex(p.hashLock));
  });

  it('reports a refund once, even though two transactions touch the user', async () => {
    const secret = new Uint8Array(32).fill(6);
    const p = params(secret, 'reverse');
    const chain = new FakeChain();
    const lock = lockTx(chain, p, userBytecode);
    const refund = buildRefundTransaction({
      params: p,
      network: 'chipnet',
      utxo: { txid: lock, vout: 0, satoshis: 3000n },
      feeSats: 500n,
    });
    chain.add(
      refund.txHex,
      userBytecode,
      deriveHtlcAddresses(p).lockingBytecode,
    );

    const { items } = await fetchBchActivity({ electrum: chain, ...base });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: lock, state: 'refunded' });
    expect(items[0]?.txs.map((tx) => tx.label)).toEqual([
      'Your lock',
      'Refund',
    ]);
  });

  it('shows a lock that has not been spent yet as waiting', async () => {
    const p = params(new Uint8Array(32).fill(4), 'reverse');
    const chain = new FakeChain();
    const lock = lockTx(chain, p, userBytecode);
    const { items } = await fetchBchActivity({ electrum: chain, ...base });
    expect(items).toMatchObject([
      { key: lock, state: 'locked', hashLock: null },
    ]);
  });

  it('ignores token sends that are not Ferry covenants', async () => {
    const chain = new FakeChain();
    const hex = binToHex(
      encodeTransactionBCH({
        version: 2,
        locktime: 0,
        inputs: [
          {
            outpointIndex: 0,
            outpointTransactionHash: hexToBin('ee'.repeat(32)),
            sequenceNumber: 0xffffffff,
            unlockingBytecode: hexToBin('00'),
          },
        ],
        outputs: [
          {
            lockingBytecode: solverBytecode,
            valueSatoshis: 3000n,
            token: { amount: 100n, category: hexToBin(displayCategory) },
          },
        ],
      }),
    );
    chain.add(hex, userBytecode);
    expect(
      (await fetchBchActivity({ electrum: chain, ...base })).items,
    ).toEqual([]);
  });

  it('merges with a saved order and a Base lock by hash lock', async () => {
    const secret = new Uint8Array(32).fill(9);
    const p = params(secret, 'forward');
    const chain = new FakeChain();
    const solverLock = lockTx(chain, p, solverBytecode);
    chain.add(
      buildClaimTransaction({
        params: p,
        network: 'chipnet',
        secret,
        utxo: { txid: solverLock, vout: 0, satoshis: 3000n },
        feeSats: 500n,
      }).txHex,
      userBytecode,
    );
    const { items } = await fetchBchActivity({ electrum: chain, ...base });
    const hashLock = `0x${binToHex(p.hashLock)}` as const;
    const order = {
      orderId: `0x${'09'.repeat(32)}`,
      createdAt: 100,
      terms: { hashLock, direction: 'COUNTER_TO_BCH' },
      transactions: [],
      bchLockUtxo: null,
    } as unknown as PersistedOrder;
    const merged = mergeActivity({
      bch: items,
      orders: [order],
      locks: [
        {
          id: `0x${'01'.repeat(32)}`,
          role: 'sender',
          token: `0x${'11'.repeat(20)}`,
          amount: 5_000_000n,
          hashLock,
          deadline: 1n,
          blockNumber: 1n,
          lockedAt: 50,
          lockTx: `0x${'aa'.repeat(32)}`,
          state: 'claimed',
          settleTx: null,
        },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.bch?.state).toBe('received');
    expect(merged[0]?.order).toBe(order);
    expect(merged[0]?.chain?.amount).toBe(5_000_000n);
  });
});
