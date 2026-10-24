import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseBchAddress } from '../lib/bch/address';
import { buildClaimTransaction } from '@ferry/htlc-bch';
import { bchParametersFromTerms } from '../lib/recovery';
import { BCH_NETWORK } from '../lib/config';
import { MOCK_BCH_USER_ADDRESS, SOLVER_SIGNING_ADDRESS } from '../lib/config';
import { buildRecoveryFile, parseRecoveryFileJson } from '../lib/recovery';
import { createMockSolverClient } from '../lib/solver/mock';
import { verifySignedQuote } from '../lib/solver/verify';
import { buildOrderViewModel } from '../lib/solver/view';
import {
  generateSecret,
  hashLockForSecret,
  parseUsdcAmount,
  quoteRate,
} from '../lib/swap';
import { serializeApiJson } from '@ferry/core';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;

function request(amountIn = 10_000_000n) {
  return {
    direction: 'COUNTER_TO_BCH' as const,
    bchToken: 'PUSD' as const,
    counterChain: 'base' as const,
    counterSymbol: 'USDC' as const,
    amountIn,
    userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
    userBchLockingBytecode: bchAddress.lockingBytecode,
    hashLock: hashLockForSecret(generateSecret()),
    lane: 'safe' as const,
  };
}

describe('swap form helpers', () => {
  it('parses USDC amounts with six decimals and enforces limits', () => {
    expect(parseUsdcAmount('42.5')).toBe(42_500_000n);
    expect(parseUsdcAmount('1')).toBe(1_000_000n);
    expect(() => parseUsdcAmount('50.01')).toThrow(
      'Swap amounts are $1 to $50',
    );
    expect(() => parseUsdcAmount('0')).toThrow('above zero');
    expect(() => parseUsdcAmount('1.1234567')).toThrow('at most 6 decimals');
  });

  it('accepts only token-aware chipnet BCH addresses', () => {
    expect(parseBchAddress(MOCK_BCH_USER_ADDRESS).ok).toBe(true);
    expect(
      parseBchAddress('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a')
        .ok,
    ).toBe(false);
    expect(parseBchAddress('bchtest:not-an-address').ok).toBe(false);
  });

  it('derives a 32-byte hash lock from a generated secret', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashLockForSecret(secret)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(hashLockForSecret(secret)).not.toBe(secret);
  });

  it('computes the displayed quote rate from terms', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request(42_500_000n));
    expect(quoteRate(quote.terms)).toBe('0.9948');
  });
});

describe('signed quote verification', () => {
  it('accepts the mock solver signature and rejects tampered terms', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());

    expect(
      await verifySignedQuote(quote, SOLVER_SIGNING_ADDRESS as Address),
    ).toBe(true);

    const tampered = {
      ...quote,
      terms: {
        ...quote.terms,
        bchTokenAmount: quote.terms.bchTokenAmount + 1n,
      },
    };
    expect(
      await verifySignedQuote(tampered, SOLVER_SIGNING_ADDRESS as Address),
    ).toBe(false);

    expect(
      await verifySignedQuote(
        quote,
        '0x0000000000000000000000000000000000000001',
      ),
    ).toBe(false);
  });
});

describe('BCH spend builder', () => {
  it('builds a claim transaction from the order terms and solver UTXO', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());
    const built = buildClaimTransaction({
      params: bchParametersFromTerms(quote.terms),
      network: BCH_NETWORK,
      secret: generateSecret(),
      utxo: {
        txid: '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
        vout: 0,
        satoshis: 3_000n,
      },
      feeSats: 500n,
    });
    expect(built.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(built.txHex.length).toBeGreaterThan(20);
  });
});

describe('recovery file', () => {
  it('round-trips bigint terms through JSON without losing the local secret', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());
    const secret = generateSecret();
    const file = buildRecoveryFile(quote.orderId, quote.terms, secret);
    const parsed = parseRecoveryFileJson(serializeApiJson(file));

    expect(parsed.orderId).toBe(quote.orderId);
    expect(parsed.terms.counterAmount).toBe(quote.terms.counterAmount);
    expect(parsed.terms.bchTokenAmount).toBe(quote.terms.bchTokenAmount);
    expect(parsed.secret).toBe(secret);
    expect(parsed.contracts.evm.address).toBe(
      '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
    );
  });
});

describe('order timeline', () => {
  it('offers a claim after the solver lock and hides it after the reveal', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());
    await solver.relayLock({
      orderId: quote.orderId,
      terms: quote.terms,
      userEvmAddress: quote.terms.userCounterAddress as Address,
      permitSignature: `0x${'11'.repeat(65)}`,
      intentSignature: `0x${'22'.repeat(65)}`,
      permitDeadline: quote.terms.counterDeadline,
    });

    let order = await solver.getOrder(quote.orderId);
    for (let index = 0; index < 3; index += 1) {
      order = await solver.getOrder(quote.orderId);
    }
    expect(order.status).toBe('SOLVER_LOCK_SEEN');
    expect(buildOrderViewModel(order).claimAvailable).toBe(true);

    await solver.submitSecret(quote.orderId, generateSecret());
    order = await solver.getOrder(quote.orderId);
    expect(order.status).toBe('USER_CLAIM_SEEN');
    expect(buildOrderViewModel(order).claimAvailable).toBe(false);
  });

  it('marks every timeline step done for a completed order', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());
    await solver.relayLock({
      orderId: quote.orderId,
      terms: quote.terms,
      userEvmAddress: quote.terms.userCounterAddress as Address,
      permitSignature: `0x${'11'.repeat(65)}`,
      intentSignature: `0x${'22'.repeat(65)}`,
      permitDeadline: quote.terms.counterDeadline,
    });
    let order = await solver.getOrder(quote.orderId);
    for (let index = 0; index < 8; index += 1) {
      order = await solver.getOrder(quote.orderId);
    }
    expect(order.status).toBe('DONE');
    expect(buildOrderViewModel(order).steps.map((step) => step.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('keeps the refund action visible for a rejected order', async () => {
    const solver = createMockSolverClient({ scenario: 'refund' });
    const order = await solver.getOrder(`0x${'55'.repeat(32)}`);
    const view = buildOrderViewModel(order);

    expect(order.status).toBe('REJECTED');
    expect(view.refundAvailable).toBe(true);
    expect(view.claimAvailable).toBe(false);
  });
});
