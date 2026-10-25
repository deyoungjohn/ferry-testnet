import type { Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseBchAddress } from '../lib/bch/address';
import { buildClaimTransaction } from '@ferry/htlc-bch';
import { bchParametersFromTerms } from '../lib/recovery';
import { BCH_NETWORK } from '../lib/config';
import {
  BCH_CARRY_SATS,
  BCH_MAX_FEE_SATS,
  FIXED_FEE_USD_MICROS,
  FWD_BCH_REFUND_BLOCKS,
  FWD_EVM_DEADLINE_S,
  MOCK_BCH_SOLVER_ADDRESS,
  MOCK_BCH_USER_ADDRESS,
  MOCK_SOLVER_SIGNING_ADDRESS,
  PUSD_CATEGORY,
  QUOTE_TTL_S,
  REV_BCH_REFUND_BLOCKS,
  REV_EVM_DEADLINE_S,
  SOLVER_COUNTER_ADDRESS,
  SPREAD_BPS,
  USDC_ADDRESS,
  USDC_DECIMALS,
  FERRY_HTLC_ADDRESS,
} from '../lib/config';
import { buildRecoveryFile, parseRecoveryFileJson } from '../lib/recovery';
import { createMockSolverClient } from '../lib/solver/mock';
import {
  assertTermsMatchRequest,
  assertTimingInvariant,
  verifySignedQuote,
  type TermsCheckConfig,
} from '../lib/solver/verify';
import { buildOrderViewModel } from '../lib/solver/view';
import {
  assertReverseFundingTarget,
  reverseFundingTarget,
} from '../lib/bch/lock';
import {
  generateSecret,
  hashLockForSecret,
  parsePusdAmount,
  parseUsdcAmount,
  quoteRate,
  buildPermitTypedData,
} from '../lib/swap';
import { serializeApiJson } from '@ferry/core';

const bchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!bchResult.ok) throw new Error(bchResult.error);
const bchAddress = bchResult.value;
const solverBchResult = parseBchAddress(MOCK_BCH_SOLVER_ADDRESS);
if (!solverBchResult.ok) throw new Error(solverBchResult.error);
const solverBchAddress = solverBchResult.value;

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
      await verifySignedQuote(quote, MOCK_SOLVER_SIGNING_ADDRESS as Address),
    ).toBe(true);

    const tampered = {
      ...quote,
      terms: {
        ...quote.terms,
        bchTokenAmount: quote.terms.bchTokenAmount + 1n,
      },
    };
    expect(
      await verifySignedQuote(tampered, MOCK_SOLVER_SIGNING_ADDRESS as Address),
    ).toBe(false);

    expect(
      await verifySignedQuote(
        quote,
        '0x0000000000000000000000000000000000000001',
      ),
    ).toBe(false);
  });
});

function reverseRequest(amountIn = 1_000n) {
  return {
    ...request(),
    direction: 'BCH_TO_COUNTER' as const,
    amountIn,
  };
}

function termsConfig(
  quote: Awaited<
    ReturnType<ReturnType<typeof createMockSolverClient>['quote']>
  >,
): TermsCheckConfig {
  const reverse = quote.terms.direction === 'BCH_TO_COUNTER';
  const refundBlocks = reverse ? REV_BCH_REFUND_BLOCKS : FWD_BCH_REFUND_BLOCKS;
  const deadline = reverse ? REV_EVM_DEADLINE_S : FWD_EVM_DEADLINE_S;
  return {
    counterChain: 'base',
    counterNetworkId: 84_532,
    counterSymbol: 'USDC',
    counterAssetAddress: USDC_ADDRESS,
    counterAssetDecimals: USDC_DECIMALS,
    counterHtlc: FERRY_HTLC_ADDRESS,
    bchToken: 'PUSD',
    bchTokenCategory: PUSD_CATEGORY,
    solverCounterAddress: SOLVER_COUNTER_ADDRESS,
    solverBchLockingBytecode: solverBchAddress.lockingBytecode,
    bchTipHeight: quote.bchTipHeight,
    bchCarrySats: BCH_CARRY_SATS,
    bchMaxFee: BCH_MAX_FEE_SATS,
    pricingPolicy: {
      spreadBps: SPREAD_BPS,
      fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
    },
    nowSeconds: Math.floor(Date.now() / 1000),
    maxQuoteFutureSeconds: QUOTE_TTL_S * 2,
    maxCounterDeadlineSeconds: deadline + 300,
    minBchRefundBlocks: refundBlocks,
    maxBchRefundBlocks: refundBlocks + 6,
  };
}

describe('T9 terms binding', () => {
  it('accepts the mock quote and rejects every tampered field with a specific reason', async () => {
    const solver = createMockSolverClient();
    const quoteRequest = request();
    const quote = await solver.quote(quoteRequest);
    const config = termsConfig(quote);

    expect(() =>
      assertTermsMatchRequest(quote.terms, quoteRequest, config),
    ).not.toThrow();

    const cases: readonly {
      readonly name: string;
      readonly patch: Record<string, unknown>;
      readonly message: string;
    }[] = [
      {
        name: 'direction',
        patch: { direction: 'BCH_TO_COUNTER' },
        message: 'direction does not match',
      },
      {
        name: 'counter chain',
        patch: { counterChain: 'ethereum' },
        message: 'counter chain does not match',
      },
      {
        name: 'counter network',
        patch: { counterNetworkId: 1 },
        message: 'counter network does not match',
      },
      {
        name: 'counter asset',
        patch: {
          counterAsset: {
            ...quote.terms.counterAsset,
            address: '0x0000000000000000000000000000000000000001',
          },
        },
        message: 'counter asset address does not match',
      },
      {
        name: 'counter decimals',
        patch: {
          counterAsset: { ...quote.terms.counterAsset, decimals: 18 },
        },
        message: 'counter asset decimals does not match',
      },
      {
        name: 'counter HTLC',
        patch: {
          counterHtlc: '0x0000000000000000000000000000000000000002',
        },
        message: 'counter HTLC does not match',
      },
      {
        name: 'user counter address',
        patch: {
          userCounterAddress: '0x0000000000000000000000000000000000000003',
        },
        message: 'user counter address does not match',
      },
      {
        name: 'user BCH bytecode',
        patch: {
          userBchLockingBytecode: '0x76a914' + '00'.repeat(20) + '88ac',
        },
        message: 'user BCH locking bytecode does not match',
      },
      {
        name: 'hash lock',
        patch: { hashLock: `0x${'11'.repeat(32)}` },
        message: 'hash lock does not match',
      },
      {
        name: 'counter amount',
        patch: { counterAmount: quote.terms.counterAmount + 1n },
        message: 'counter amount does not match',
      },
      {
        name: 'BCH token',
        patch: { bchToken: 'MUSD' },
        message: 'BCH token does not match',
      },
      {
        name: 'BCH category',
        patch: { bchTokenCategory: `0x${'22'.repeat(32)}` },
        message: 'BCH token category does not match',
      },
      {
        name: 'solver counter address',
        patch: {
          solverCounterAddress: '0x0000000000000000000000000000000000000004',
        },
        message: 'solver counter address does not match',
      },
      {
        name: 'worse payout',
        patch: { bchTokenAmount: quote.terms.bchTokenAmount - 1n },
        message: 'payout is worse',
      },
      {
        name: 'carry',
        patch: { bchCarrySats: BCH_CARRY_SATS + 1n },
        message: 'BCH carry does not match',
      },
      {
        name: 'max fee',
        patch: { bchMaxFee: BCH_MAX_FEE_SATS + 1n },
        message: 'BCH max fee exceeds',
      },
      {
        name: 'expired quote',
        patch: { quoteExpiry: 1 },
        message: 'already expired',
      },
      {
        name: 'quote too long',
        patch: { quoteExpiry: quote.terms.quoteExpiry + 3_600 },
        message: 'expiry is too far',
      },
      {
        name: 'counter deadline expired',
        patch: { counterDeadline: 1 },
        message: 'counter deadline is already expired',
      },
      {
        name: 'counter deadline too long',
        patch: { counterDeadline: quote.terms.counterDeadline + 3_600 },
        message: 'counter deadline is too far',
      },
      {
        name: 'refund too soon',
        patch: {
          bchRefundHeight: quote.bchTipHeight + FWD_BCH_REFUND_BLOCKS - 1,
        },
        message: 'refund height is too soon',
      },
      {
        name: 'refund too far',
        patch: {
          bchRefundHeight: quote.bchTipHeight + FWD_BCH_REFUND_BLOCKS + 7,
        },
        message: 'refund height is too far',
      },
    ];

    for (const item of cases) {
      expect(
        () =>
          assertTermsMatchRequest(
            { ...quote.terms, ...item.patch },
            quoteRequest,
            config,
          ),
        item.name,
      ).toThrow(item.message);
    }
  });
});

describe('permit and intent deadlines', () => {
  it('uses the short quote expiry for both permit and intent deadlines', async () => {
    const solver = createMockSolverClient();
    const quote = await solver.quote(request());
    const permit = buildPermitTypedData(
      quote.terms,
      '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
      0n,
    );
    expect(permit.message.deadline).toBe(BigInt(quote.terms.quoteExpiry));
    expect(permit.message.deadline).not.toBe(
      BigInt(quote.terms.counterDeadline),
    );
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
      '0x5a0c062f4b7b8ff2263530e12bc15de9c836a641',
    );
  });
});

describe('order timeline', () => {
  it('offers a claim after the solver lock and hides it after the reveal', async () => {
    const solver = createMockSolverClient();
    const secret = generateSecret();
    const quote = await solver.quote({
      ...request(),
      hashLock: hashLockForSecret(secret),
    });
    await solver.relayLock({
      orderId: quote.orderId,
      terms: quote.terms,
      userEvmAddress: quote.terms.userCounterAddress as Address,
      permitSignature: `0x${'11'.repeat(65)}`,
      intentSignature: `0x${'22'.repeat(65)}`,
      permitDeadline: quote.terms.quoteExpiry,
    });

    let order = await solver.getOrder(quote.orderId);
    for (let index = 0; index < 3; index += 1) {
      order = await solver.getOrder(quote.orderId);
    }
    expect(order.status).toBe('SOLVER_LOCK_SEEN');
    expect(buildOrderViewModel(order).claimAvailable).toBe(true);

    await solver.submitSecret(quote.orderId, secret);
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
      permitDeadline: quote.terms.quoteExpiry,
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

describe('solver signer configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('refuses a live solver URL without a pinned signer', async () => {
    vi.stubEnv('VITE_SOLVER_URL', 'http://solver.test');
    vi.stubEnv('VITE_SOLVER_SIGNING_ADDRESS', '');
    vi.resetModules();
    const config = await import('../lib/config');
    expect(() => config.requireSolverSigner()).toThrow(
      /VITE_SOLVER_SIGNING_ADDRESS/,
    );
  });

  it('returns the configured signer for a live solver', async () => {
    vi.stubEnv('VITE_SOLVER_URL', 'http://solver.test');
    vi.stubEnv(
      'VITE_SOLVER_SIGNING_ADDRESS',
      '0x00000000000000000000000000000000000000aa',
    );
    vi.resetModules();
    const config = await import('../lib/config');
    expect(config.requireSolverSigner()).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
  });
});

describe('reverse swap', () => {
  it('parses tPUSD amounts with two decimals and the same USD limits', () => {
    expect(parsePusdAmount('10.00')).toBe(1_000n);
    expect(parsePusdAmount('1')).toBe(100n);
    expect(parsePusdAmount('50.00')).toBe(5_000n);
    expect(() => parsePusdAmount('50.01')).toThrow(
      'Swap amounts are $1 to $50',
    );
    expect(() => parsePusdAmount('10.001')).toThrow('at most 2 decimals');
  });

  it('allows both directions from one mock so the toggle can quote', async () => {
    const solver = createMockSolverClient();
    const reverseQuote = await solver.quote(reverseRequest());
    const forwardQuote = await solver.quote(request());

    expect(reverseQuote.terms.direction).toBe('BCH_TO_COUNTER');
    expect(forwardQuote.terms.direction).toBe('COUNTER_TO_BCH');
  });

  it('quotes tPUSD in and USDC out with reverse terms', async () => {
    const solver = createMockSolverClient({ direction: 'BCH_TO_COUNTER' });
    const quote = await solver.quote(reverseRequest(1_000n));

    expect(quote.terms.direction).toBe('BCH_TO_COUNTER');
    expect(quote.terms.bchTokenAmount).toBe(1_000n);
    expect(quote.terms.counterAmount).toBeGreaterThan(0n);
    expect(quote.terms.bchRefundHeight - quote.bchTipHeight).toBe(
      REV_BCH_REFUND_BLOCKS,
    );
    expect(quoteRate(quote.terms)).toMatch(/^\d+\.\d{4}$/);
  });

  it('binds reverse terms to the request and passes invariant R', async () => {
    const solver = createMockSolverClient({ direction: 'BCH_TO_COUNTER' });
    const quoteRequest = reverseRequest();
    const quote = await solver.quote(quoteRequest);
    const config = termsConfig(quote);

    expect(() =>
      assertTermsMatchRequest(quote.terms, quoteRequest, config),
    ).not.toThrow();
    expect(() => assertTimingInvariant(quote.terms, config)).not.toThrow();

    expect(() =>
      assertTermsMatchRequest(
        {
          ...quote.terms,
          solverBchLockingBytecode: `0x${'77'.repeat(32)}`,
        },
        quoteRequest,
        config,
      ),
    ).toThrow('solver BCH locking bytecode does not match');
    expect(() =>
      assertTermsMatchRequest(
        { ...quote.terms, counterAmount: quote.terms.counterAmount - 1n },
        quoteRequest,
        config,
      ),
    ).toThrow('payout is worse');
  });

  it('recomputes the token-aware funding target and refuses a mismatched wallet', async () => {
    const solver = createMockSolverClient({ direction: 'BCH_TO_COUNTER' });
    const quote = await solver.quote(reverseRequest());
    const target = reverseFundingTarget(quote.terms);

    expect(target.tokenAmount).toBe(quote.terms.bchTokenAmount);
    expect(target.htlcTokenAddress).toMatch(/^bchtest:/);
    expect(() =>
      assertReverseFundingTarget(
        quote.terms,
        bchAddress.lockingBytecode,
        solverBchAddress.lockingBytecode,
      ),
    ).not.toThrow();
    expect(() =>
      assertReverseFundingTarget(
        quote.terms,
        `0x76a914${'00'.repeat(20)}88ac`,
        solverBchAddress.lockingBytecode,
      ),
    ).toThrow('refund address does not match');
  });

  it('advances a reverse order through the relayed USDC claim', async () => {
    const solver = createMockSolverClient({ direction: 'BCH_TO_COUNTER' });
    const secret = generateSecret();
    const quote = await solver.quote({
      ...reverseRequest(),
      hashLock: hashLockForSecret(secret),
    });
    let order = await solver.getOrder(quote.orderId);
    for (let index = 0; index < 3; index += 1) {
      order = await solver.getOrder(quote.orderId);
    }
    expect(order.status).toBe('SOLVER_LOCK_SEEN');
    expect(buildOrderViewModel(order).claimAvailable).toBe(true);

    await solver.relayClaim(quote.orderId, secret);
    order = await solver.getOrder(quote.orderId);
    expect(order.status).toBe('USER_CLAIM_SEEN');
    expect(buildOrderViewModel(order).claimAvailable).toBe(false);
    expect(buildOrderViewModel(order).statusLabel).toBe('Your USDC claim seen');
  });

  it('offers a BCH refund after the reverse refund height', async () => {
    const solver = createMockSolverClient({
      scenario: 'refund',
      direction: 'BCH_TO_COUNTER',
    });
    const order = await solver.getOrder(`0x${'66'.repeat(32)}`);
    const view = buildOrderViewModel(order);

    expect(order.status).toBe('REJECTED');
    expect(view.bchRefundAvailable).toBe(true);
    expect(view.refundAvailable).toBe(false);
    expect(view.blocksRemaining).toBe(0);
    expect(view.statusLabel).toBe('Swap rejected');
  });
});
