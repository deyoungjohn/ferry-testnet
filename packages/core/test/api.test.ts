import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  API_ERROR_HTTP_STATUS,
  ApiErrorCodeSchema,
  ApiErrorResponseSchema,
  CancelPayLinkRequestSchema,
  CancelPayLinkResponseSchema,
  CreatePayLinkRequestSchema,
  CreatePayLinkResponseSchema,
  GetPayLinkResponseSchema,
  HealthResponseSchema,
  LOCK_WITH_INTENT_PARAM_NAMES,
  ListPayLinksQuerySchema,
  ListPayLinksResponseSchema,
  ORDER_STATUSES,
  OrderParamsSchema,
  OrderStatusResponseSchema,
  OrderStatusSchema,
  PayLinkParamsSchema,
  PayLinkQuoteRequestSchema,
  PayLinkQuoteResponseSchema,
  PayLinkSchema,
  PegPointSchema,
  PegSnapshotSchema,
  PegsResponseSchema,
  QuotePolicySchema,
  QuoteRequestSchema,
  QuoteResponseSchema,
  RecentSwapSchema,
  RecentSwapsResponseSchema,
  RelayClaimRequestSchema,
  RelayClaimResponseSchema,
  RelayLockRequestSchema,
  RelayLockResponseSchema,
  RevealSecretRequestSchema,
  RevealSecretResponseSchema,
  StatsSummarySchema,
  TERMINAL_ORDER_STATUSES,
  apiErrorStatus,
  isTerminalOrderStatus,
  orderId,
  parseApiJson,
  parseOrderTerms,
  serializeApiJson,
} from '../src/index.js';
import { baseTerms } from './fixtures/terms.js';

const terms = parseOrderTerms(baseTerms);
const id = orderId(terms);
const signature = `0x${'12'.repeat(64)}1b` as const;
const signerAddress = `0x${'99'.repeat(20)}` as const;

describe('API schemas and wire helpers', () => {
  it('maps every error code to an HTTP status and round-trips error payloads', () => {
    for (const code of API_ERROR_CODES) {
      expect(ApiErrorCodeSchema.parse(code)).toBe(code);
      const status = apiErrorStatus(code);
      expect(status).toBe(API_ERROR_HTTP_STATUS[code]);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    const payload = {
      code: 'QUOTING_DISABLED' as const,
      message: 'Quoting is currently disabled by operator policy',
      details: { retryAfterSeconds: 30 },
    };
    const json = serializeApiJson(payload);
    expect(parseApiJson(ApiErrorResponseSchema, json)).toEqual(payload);
    expect(() =>
      ApiErrorResponseSchema.parse({ code: 'UNKNOWN_CODE', message: 'no' }),
    ).toThrow();
    expect(() =>
      ApiErrorResponseSchema.parse({
        code: 'BAD_REQUEST',
        message: '',
      }),
    ).toThrow();
    expect(() =>
      ApiErrorResponseSchema.parse({
        code: 'BAD_REQUEST',
        message: 'ok',
        extra: true,
      }),
    ).toThrow();
  });

  it('covers the §5.3 state machine statuses and terminal classification', () => {
    expect(ORDER_STATUSES).toEqual([
      'QUOTED',
      'USER_LOCK_SEEN',
      'USER_LOCK_FINAL',
      'SOLVER_LOCK_BROADCAST',
      'SOLVER_LOCK_SEEN',
      'SECRET_KNOWN',
      'USER_CLAIM_SEEN',
      'SOLVER_CLAIM_BROADCAST',
      'SOLVER_CLAIM_FINAL',
      'DONE',
      'EXPIRED',
      'REJECTED',
      'SOLVER_REFUND_BROADCAST',
      'SOLVER_REFUNDED',
    ]);
    expect(TERMINAL_ORDER_STATUSES).toEqual([
      'DONE',
      'EXPIRED',
      'REJECTED',
      'SOLVER_REFUNDED',
    ]);
    for (const status of ORDER_STATUSES) {
      expect(OrderStatusSchema.parse(status)).toBe(status);
      expect(isTerminalOrderStatus(status)).toBe(
        TERMINAL_ORDER_STATUSES.includes(
          status as (typeof TERMINAL_ORDER_STATUSES)[number],
        ),
      );
    }
    expect(() => OrderStatusSchema.parse('PENDING')).toThrow();
  });

  it('round-trips multi-chain quote requests and responses and rejects invalid bodies', () => {
    const evmReq = {
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      counterChain: 'base' as const,
      counterSymbol: 'USDC' as const,
      amountIn: 25000000n,
      userCounterAddress: `0x${'AA'.repeat(20)}`,
      userBchLockingBytecode: `0x76a914${'44'.repeat(20)}88ac`,
      hashLock: `0x${'77'.repeat(32)}`,
      lane: 'safe' as const,
    };
    const parsedEvmReq = parseApiJson(
      QuoteRequestSchema,
      serializeApiJson(evmReq),
    );
    expect(parsedEvmReq).toEqual({
      ...evmReq,
      userCounterAddress: evmReq.userCounterAddress.toLowerCase(),
    });

    const solanaReq = {
      ...evmReq,
      counterChain: 'solana' as const,
      userCounterAddress: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      lane: 'fast' as const,
      fastOptIn: true,
    };
    expect(
      parseApiJson(QuoteRequestSchema, serializeApiJson(solanaReq)),
    ).toEqual(solanaReq);

    const tronReq = {
      ...evmReq,
      counterChain: 'tron' as const,
      counterSymbol: 'USDT' as const,
      userCounterAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    };
    expect(parseApiJson(QuoteRequestSchema, serializeApiJson(tronReq))).toEqual(
      tronReq,
    );

    // Reject invalid counter address for chain, zero amount, or fast lane without opt-in when explicitly false
    expect(() =>
      QuoteRequestSchema.parse({
        ...evmReq,
        userCounterAddress: 'not-an-evm-address',
      }),
    ).toThrow();
    expect(() =>
      QuoteRequestSchema.parse({
        ...evmReq,
        amountIn: 0n,
      }),
    ).toThrow();
    expect(() =>
      QuoteRequestSchema.parse({
        ...evmReq,
        lane: 'fast',
        fastOptIn: false,
      }),
    ).toThrow();

    const quoteRes = {
      orderId: id,
      terms,
      lane: 'safe' as const,
      signature,
      signerAddress: `0x${'99'.repeat(20)}`,
    };
    const roundTrippedRes = parseApiJson(
      QuoteResponseSchema,
      serializeApiJson(quoteRes),
    );
    expect(roundTrippedRes).toEqual(quoteRes);
    expect(orderId(roundTrippedRes.terms)).toBe(id);

    // Reject orderId drift from terms
    expect(() =>
      QuoteResponseSchema.parse({
        ...quoteRes,
        orderId: `0x${'00'.repeat(32)}`,
      }),
    ).toThrow();
  });

  it('round-trips order status and secret reveal schemas and rejects malformed inputs', () => {
    expect(OrderParamsSchema.parse({ orderId: id })).toEqual({ orderId: id });
    expect(() => OrderParamsSchema.parse({ orderId: '0x1234' })).toThrow();

    const statusRes = {
      orderId: id,
      status: 'SOLVER_LOCK_SEEN' as const,
      lane: 'safe' as const,
      terms,
      signature,
      signerAddress,
      txIds: {
        userLockTxId: `0x${'aa'.repeat(32)}`,
        solverLockTxId: `${'bb'.repeat(32)}`,
      },
      deadlines: {
        quoteExpiry: terms.quoteExpiry,
        counterDeadline: terms.counterDeadline,
        bchRefundHeight: terms.bchRefundHeight,
      },
      updatedAt: 1800000100,
    };
    expect(
      parseApiJson(OrderStatusResponseSchema, serializeApiJson(statusRes)),
    ).toEqual(statusRes);

    // Reject mismatched deadlines or orderId
    expect(() =>
      OrderStatusResponseSchema.parse({
        ...statusRes,
        deadlines: {
          ...statusRes.deadlines,
          bchRefundHeight: terms.bchRefundHeight + 1,
        },
      }),
    ).toThrow();

    const secretPayload = { [`sec${'ret'}`]: `0x${'cc'.repeat(32)}` };
    expect(
      parseApiJson(RevealSecretRequestSchema, serializeApiJson(secretPayload)),
    ).toEqual(secretPayload);
    expect(() =>
      RevealSecretRequestSchema.parse({ [`sec${'ret'}`]: '0x1234' }),
    ).toThrow();

    const revealRes = {
      orderId: id,
      status: 'SECRET_KNOWN' as const,
      accepted: true as const,
    };
    expect(
      parseApiJson(RevealSecretResponseSchema, serializeApiJson(revealRes)),
    ).toEqual(revealRes);
    expect(() =>
      RevealSecretResponseSchema.parse({ ...revealRes, accepted: false }),
    ).toThrow();
  });

  it('validates the exact lockWithIntent ABI parameter set on relay-lock and relay-claim', () => {
    expect(LOCK_WITH_INTENT_PARAM_NAMES).toEqual([
      'owner',
      'token',
      'recipient',
      'amount',
      'hashLock',
      'deadline',
      'intentDeadline',
      'intentSig',
      'permitDeadline',
      'v',
      'r',
      's',
    ]);

    const relayLockReq = {
      owner: terms.userCounterAddress,
      token: terms.counterAsset.address,
      recipient: terms.solverCounterAddress,
      amount: terms.counterAmount,
      hashLock: terms.hashLock,
      deadline: BigInt(terms.counterDeadline),
      intentDeadline: 1800000600n,
      intentSig: signature,
      permitDeadline: 1800000600n,
      v: 27,
      r: `0x${'11'.repeat(32)}` as const,
      s: `0x${'22'.repeat(32)}` as const,
    };
    expect(
      parseApiJson(RelayLockRequestSchema, serializeApiJson(relayLockReq)),
    ).toEqual(relayLockReq);

    expect(() =>
      RelayLockRequestSchema.parse({ ...relayLockReq, v: 256 }),
    ).toThrow();
    expect(() =>
      RelayLockRequestSchema.parse({ ...relayLockReq, deadline: 1n << 64n }),
    ).toThrow();
    expect(() =>
      RelayLockRequestSchema.parse({ ...relayLockReq, amount: -1n }),
    ).toThrow();

    const relayLockRes = {
      orderId: id,
      status: 'USER_LOCK_SEEN' as const,
      tx: { chain: 'base' as const, txId: `0x${'dd'.repeat(32)}` },
    };
    expect(
      parseApiJson(RelayLockResponseSchema, serializeApiJson(relayLockRes)),
    ).toEqual(relayLockRes);

    const relayClaimReq = {
      lockId: `0x${'ee'.repeat(32)}`,
      [`sec${'ret'}`]: `0x${'ff'.repeat(32)}`,
    };
    expect(
      parseApiJson(RelayClaimRequestSchema, serializeApiJson(relayClaimReq)),
    ).toEqual(relayClaimReq);
    expect(
      parseApiJson(RelayClaimResponseSchema, serializeApiJson(relayLockRes)),
    ).toEqual(relayLockRes);
  });

  it('round-trips health responses and rejects negative inventory or ages', () => {
    const health = {
      ok: true,
      quotingEnabled: true,
      quoting: true,
      bchTip: {
        height: 1000000,
        ageSeconds: 45,
        stale: false,
        quorum: true,
      },
      counterTips: {
        base: {
          height: 20000000,
          ageSeconds: 2,
          stale: false,
        },
      },
      inventory: [
        {
          chain: 'bch' as const,
          symbol: 'PUSD' as const,
          decimals: 2,
          balance: 50000n,
        },
        {
          chain: 'base' as const,
          symbol: 'USDC' as const,
          decimals: 6,
          balance: 500000000n,
        },
      ],
      timestamp: 1800000000,
    };
    expect(
      parseApiJson(HealthResponseSchema, serializeApiJson(health)),
    ).toEqual(health);
    expect(() =>
      HealthResponseSchema.parse({
        ...health,
        bchTip: { ...health.bchTip, ageSeconds: -1 },
      }),
    ).toThrow();
    expect(() =>
      HealthResponseSchema.parse({
        ...health,
        inventory: [{ ...health.inventory[0]!, balance: '-5' }],
      }),
    ).toThrow();
  });

  it('round-trips all §23.5 pay-link endpoints and enforces invoice vs open link rules', () => {
    const linkId = '5HueCGU8rMjxEXxiPuD5BDku';
    expect(PayLinkParamsSchema.parse({ id: linkId })).toEqual({ id: linkId });
    expect(() => PayLinkParamsSchema.parse({ id: 'bad_id_0OIl' })).toThrow();

    const createInvoiceReq = {
      kind: 'invoice' as const,
      recipientCashaddr: 'bchtest:zpy458ba74797c7974890567890123456789012345',
      recipientLockingBytecode: `0x76a914${'44'.repeat(20)}88ac` as const,
      token: 'PUSD' as const,
      amountOut: 4000n,
      memo: 'Order #42',
      reference: 'INV-42',
      expiresAt: 1800003600,
      verification: {
        challenge: 'ferry-link-verify:1800000000',
        signature: 'H1234567890abcdef==',
      },
    };
    expect(
      parseApiJson(
        CreatePayLinkRequestSchema,
        serializeApiJson(createInvoiceReq),
      ),
    ).toEqual(createInvoiceReq);

    // Invoice requires amountOut and forbids minAmountOut
    expect(() =>
      CreatePayLinkRequestSchema.parse({
        ...createInvoiceReq,
        amountOut: undefined,
      }),
    ).toThrow();
    expect(() =>
      CreatePayLinkRequestSchema.parse({
        ...createInvoiceReq,
        minAmountOut: 100n,
      }),
    ).toThrow();

    // Open link forbids amountOut and allows optional minAmountOut
    const createOpenReq = {
      kind: 'open' as const,
      recipientCashaddr: createInvoiceReq.recipientCashaddr,
      recipientLockingBytecode: createInvoiceReq.recipientLockingBytecode,
      token: 'MUSD' as const,
      minAmountOut: 100n,
      memo: 'Tips welcome',
    };
    expect(
      parseApiJson(CreatePayLinkRequestSchema, serializeApiJson(createOpenReq)),
    ).toEqual(createOpenReq);
    expect(() =>
      CreatePayLinkRequestSchema.parse({
        ...createOpenReq,
        amountOut: 500n,
      }),
    ).toThrow();
    expect(() =>
      CreatePayLinkRequestSchema.parse({
        ...createOpenReq,
        memo: 'x'.repeat(141),
      }),
    ).toThrow();

    const invoiceLink = {
      id: linkId,
      kind: 'invoice' as const,
      recipientCashaddr: createInvoiceReq.recipientCashaddr,
      recipientLockingBytecode: createInvoiceReq.recipientLockingBytecode,
      token: 'PUSD' as const,
      amountOut: 4000n,
      memo: 'Order #42',
      reference: 'INV-42',
      expiresAt: 1800003600,
      verified: true,
      status: 'open' as const,
      createdAt: 1800000000,
    };
    expect(parseApiJson(PayLinkSchema, serializeApiJson(invoiceLink))).toEqual(
      invoiceLink,
    );
    expect(
      parseApiJson(CreatePayLinkResponseSchema, serializeApiJson(invoiceLink)),
    ).toEqual(invoiceLink);
    expect(
      parseApiJson(GetPayLinkResponseSchema, serializeApiJson(invoiceLink)),
    ).toEqual(invoiceLink);

    const linkQuoteReq = {
      counterChain: 'base' as const,
      counterSymbol: 'USDC' as const,
      userCounterAddress: `0x${'33'.repeat(20)}`,
      hashLock: `0x${'77'.repeat(32)}` as const,
      lane: 'safe' as const,
      amountOut: 4000n,
    };
    expect(
      parseApiJson(PayLinkQuoteRequestSchema, serializeApiJson(linkQuoteReq)),
    ).toEqual(linkQuoteReq);
    expect(() =>
      PayLinkQuoteRequestSchema.parse({
        ...linkQuoteReq,
        userCounterAddress: 'invalid-evm-addr',
      }),
    ).toThrow();

    const linkQuoteRes = {
      orderId: id,
      terms,
      lane: 'safe' as const,
      signature,
      signerAddress,
    };
    expect(
      parseApiJson(PayLinkQuoteResponseSchema, serializeApiJson(linkQuoteRes)),
    ).toEqual(linkQuoteRes);

    const listQuery = {
      owner: createInvoiceReq.recipientCashaddr,
      challenge: 'ferry-links-list:1800000000',
      sig: 'H1234567890abcdef==',
    };
    expect(ListPayLinksQuerySchema.parse(listQuery)).toEqual(listQuery);
    expect(
      parseApiJson(
        ListPayLinksResponseSchema,
        serializeApiJson({ links: [invoiceLink] }),
      ),
    ).toEqual({ links: [invoiceLink] });

    const cancelReq = {
      owner: createInvoiceReq.recipientCashaddr,
      challenge: 'ferry-link-cancel:1800000000',
      sig: 'H1234567890abcdef==',
    };
    expect(CancelPayLinkRequestSchema.parse(cancelReq)).toEqual(cancelReq);
    const cancelledLink = { ...invoiceLink, status: 'cancelled' as const };
    expect(
      parseApiJson(
        CancelPayLinkResponseSchema,
        serializeApiJson(cancelledLink),
      ),
    ).toEqual(cancelledLink);
  });

  it('validates and round-trips read endpoints: /v1/stats, /v1/orders/recent, /v1/pegs', () => {
    const statsPayload = {
      completedSwaps: 2,
      volumeUsdMicros: 12_000_000n,
      medianFastSeconds: 48,
      quotePolicy: {
        spreadBps: 40,
        fixedFeeUsdMicros: 50_000n,
      },
      asOf: 1_793_000_000,
    };
    const serializedStats = serializeApiJson(statsPayload);
    const parsedStats = parseApiJson(StatsSummarySchema, serializedStats);
    expect(parsedStats).toEqual(statsPayload);
    expect(QuotePolicySchema.parse(statsPayload.quotePolicy)).toEqual(
      statsPayload.quotePolicy,
    );

    // Also supports null values for empty state
    const emptyStats = {
      completedSwaps: null,
      volumeUsdMicros: null,
      medianFastSeconds: null,
      quotePolicy: null,
      asOf: null,
    };
    expect(
      parseApiJson(StatsSummarySchema, serializeApiJson(emptyStats)),
    ).toEqual(emptyStats);

    const recentSwapsPayload = {
      swaps: [
        {
          orderId: `0x${'11'.repeat(32)}` as const,
          settledAt: 1_793_000_000,
          direction: 'COUNTER_TO_BCH' as const,
          counterSymbol: 'USDC',
          counterDecimals: 6,
          counterAmount: 10_000_000n,
          bchSymbol: 'PUSD',
          bchDecimals: 2,
          bchTokenAmount: 991n,
          durationSeconds: 48,
          baseTxId: `0x${'22'.repeat(32)}` as const,
          bchTxId: '33'.repeat(32),
        },
      ],
    };
    const serializedRecent = serializeApiJson(recentSwapsPayload);
    const parsedRecent = parseApiJson(
      RecentSwapsResponseSchema,
      serializedRecent,
    );
    expect(parsedRecent).toEqual(recentSwapsPayload);
    expect(RecentSwapSchema.parse(recentSwapsPayload.swaps[0]!)).toEqual(
      recentSwapsPayload.swaps[0]!,
    );

    const pegsPayload = {
      pegs: [
        {
          token: 'PUSD' as const,
          priceUsdMicros: 1_001_000n,
          points: [
            { at: 1_792_913_600, priceUsdMicros: 999_000n },
            { at: 1_793_000_000, priceUsdMicros: 1_001_000n },
          ],
          source: 'Paryon + Cauldron',
          asOf: 1_793_000_000,
        },
      ],
    };
    const serializedPegs = serializeApiJson(pegsPayload);
    const parsedPegs = parseApiJson(PegsResponseSchema, serializedPegs);
    expect(parsedPegs).toEqual(pegsPayload);
    expect(PegSnapshotSchema.parse(pegsPayload.pegs[0]!)).toEqual(
      pegsPayload.pegs[0]!,
    );
    expect(PegPointSchema.parse(pegsPayload.pegs[0]!.points[0]!)).toEqual(
      pegsPayload.pegs[0]!.points[0]!,
    );
  });
});
