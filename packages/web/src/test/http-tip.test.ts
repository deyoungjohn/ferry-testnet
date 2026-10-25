import { serializeApiJson } from '@ferry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSecret, hashLockForSecret } from '../lib/swap';
import { MOCK_BCH_USER_ADDRESS } from '../lib/config';
import { parseBchAddress } from '../lib/bch/address';
import { createMockSolverClient } from '../lib/solver/mock';
import { HttpSolverClient } from '../lib/solver/http';
import type { BchTipReader } from '../lib/bch/tip';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;

function quoteRequest() {
  return {
    direction: 'COUNTER_TO_BCH' as const,
    bchToken: 'PUSD' as const,
    counterChain: 'base' as const,
    counterSymbol: 'USDC' as const,
    amountIn: 10_000_000n,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: bchAddress.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe' as const,
  };
}

function quoteResponse() {
  return createMockSolverClient().quote(quoteRequest());
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSolverClient independent BCH tip', () => {
  it('attaches the Electrum tip instead of inferring it from refund height', async () => {
    const quote = await quoteResponse();
    const { bchTipHeight, ...response } = quote;
    void bchTipHeight;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(serializeApiJson(response))),
    );
    const reader: BchTipReader = { read: async () => 123_456 };
    const client = new HttpSolverClient('http://solver.test', reader);
    const result = await client.quote(quoteRequest());

    expect(result.bchTipHeight).toBe(123_456);
    expect(result.bchTipHeight).not.toBe(result.terms.bchRefundHeight - 36);
  });

  it('fails closed when the independent tip is unreachable', async () => {
    const quote = await quoteResponse();
    const { bchTipHeight, ...response } = quote;
    void bchTipHeight;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(serializeApiJson(response))),
    );
    const reader: BchTipReader = {
      read: async () => {
        throw new Error('connection refused');
      },
    };
    const client = new HttpSolverClient('http://solver.test', reader);

    await expect(client.quote(quoteRequest())).rejects.toThrow(
      'BCH tip unavailable; refusing to quote without an independent height',
    );
  });

  it('maps bchLock from the status response and keeps the order readable without a tip', async () => {
    const quote = await quoteResponse();
    const response = {
      orderId: quote.orderId,
      status: 'USER_LOCK_SEEN' as const,
      lane: 'safe' as const,
      terms: quote.terms,
      signature: quote.signature,
      signerAddress: quote.signerAddress,
      txIds: { userLockTxId: `0x${'11'.repeat(32)}` },
      bchLock: {
        txid: '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
        vout: 0,
        satoshis: 3_000n,
      },
      deadlines: {
        quoteExpiry: quote.terms.quoteExpiry,
        counterDeadline: quote.terms.counterDeadline,
        bchRefundHeight: quote.terms.bchRefundHeight,
      },
      updatedAt: 1,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(serializeApiJson(response))),
    );
    const reader: BchTipReader = {
      read: async () => {
        throw new Error('electrum down');
      },
    };
    const client = new HttpSolverClient('http://solver.test', reader);
    const order = await client.getOrder(quote.orderId);

    expect(order.bchLockUtxo).toEqual({
      txid: response.bchLock.txid,
      vout: 0,
      satoshis: 3_000n,
    });
    expect(order.bchTipError).toBe('electrum down');
    expect(order.bchRefundAvailable).toBe(false);
  });
});
