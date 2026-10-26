import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockSolverClient } from '../lib/solver/mock';
import {
  deleteOrderDatabase,
  loadOrderRecord,
  saveOrderRecord,
  saveQuoteRecord,
} from '../lib/orders/store';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { parseBchAddress } from '../lib/bch/address';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';

const parsed = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!parsed.ok) throw new Error(parsed.error);
const bchAddress = parsed.value;

async function quote() {
  return createMockSolverClient().quote({
    direction: 'COUNTER_TO_BCH',
    bchToken: 'PUSD',
    counterChain: 'base',
    counterSymbol: 'USDC',
    amountIn: 10_000_000n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: bchAddress.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe',
  });
}

beforeEach(async () => {
  await deleteOrderDatabase();
});

afterEach(async () => {
  await deleteOrderDatabase();
});

describe('order journal', () => {
  it('persists terms and status without a secret', async () => {
    const signed = await quote();
    await saveQuoteRecord(signed, false);
    const stored = await loadOrderRecord(signed.orderId);

    expect(stored?.terms.hashLock).toBe(signed.terms.hashLock);
    expect(stored?.status).toBe('QUOTED');
    expect(stored?.solverLive).toBe(false);
    expect(Object.keys(stored ?? {})).not.toContain('secret');
    expect(
      JSON.stringify(stored, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ).not.toMatch(/secret/i);
  });

  it('updates txids while retaining the original creation time', async () => {
    const signed = await quote();
    await saveQuoteRecord(signed, true);
    const created = await loadOrderRecord(signed.orderId);
    await saveOrderRecord(
      {
        orderId: signed.orderId,
        status: 'USER_LOCK_SEEN',
        terms: signed.terms,
        lane: signed.lane,
        bchTipHeight: signed.bchTipHeight,
        bchTipError: null,
        updatedAt: Math.floor(Date.now() / 1_000) + 1,
        transactions: [
          {
            label: 'Base lock',
            chain: 'base',
            hash: `0x${'11'.repeat(32)}`,
          },
        ],
        bchLockUtxo: null,
        claimAvailable: false,
        refundAvailable: false,
        bchRefundAvailable: false,
      },
      true,
    );
    const stored = await loadOrderRecord(signed.orderId);

    expect(stored?.status).toBe('USER_LOCK_SEEN');
    expect(stored?.transactions[0]?.hash).toBe(`0x${'11'.repeat(32)}`);
    expect(stored?.createdAt).toBe(created?.createdAt);
  });
});
