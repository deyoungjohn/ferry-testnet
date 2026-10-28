import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from 'viem';
import type { FastifyInstance } from 'fastify';
import {
  HealthResponseSchema,
  OrderStatusResponseSchema,
  PayLinkSchema,
  QuoteResponseSchema,
  RecentSwapsResponseSchema,
  StatsSummarySchema,
} from '@ferry/core';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverConfigSchema } from '../src/config.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';

describe('API Time Units Contract (Unix Seconds Standard)', () => {
  let app: FastifyInstance;
  let db: SolverDatabase;
  let fakeBchClient: BchQuorumClient;
  let fakeEvmAdapter: EvmChainAdapter;
  let engine: SolverEngine;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const operatorToken = 'test-operator-secret-token-32-chars-long-1234';

  function assertTimestampSeconds(
    ts: unknown,
    label: string,
    maxDeviationSec = 86400 * 2,
  ): void {
    expect(typeof ts, `${label} must be a number`).toBe('number');
    const num = ts as number;
    expect(Number.isInteger(num), `${label} must be an integer`).toBe(true);
    expect(
      num,
      `${label} must be in seconds (> 1e9, got ${num})`,
    ).toBeGreaterThan(1_000_000_000);
    expect(
      num,
      `${label} must NOT be in milliseconds (< 1e11, got ${num})`,
    ).toBeLessThan(100_000_000_000);

    const nowSec = Math.floor(Date.now() / 1000);
    expect(
      Math.abs(num - nowSec),
      `${label} (${num}) must be within ${maxDeviationSec}s of now (${nowSec})`,
    ).toBeLessThanOrEqual(maxDeviationSec);
  }

  beforeAll(async () => {
    db = new SolverDatabase(':memory:');

    fakeBchClient = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: { 'wss://mock1': 330000, 'wss://mock2': 330000 },
        isQuorumHealthy: true,
        ageSeconds: 20,
        lastConfirmedAt: Math.floor(Date.now() / 1000) - 20,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => '0xmock-bch-broadcast',
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: async () => {},
      subscribe: () => {},
      unsubscribe: () => {},
      close: () => {},
    } as unknown as BchQuorumClient;

    fakeEvmAdapter = {
      address: solverAddress,
      lockId: (sender: `0x${string}`, hashLock: `0x${string}`) =>
        sha256(`0x${sender.slice(2)}${hashLock.slice(2)}`),
      getTip: async () => ({
        height: 1234567,
        timestamp: Math.floor(Date.now() / 1000) - 10,
        ageSeconds: 10,
      }),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';
    engine = new SolverEngine(
      db,
      fakeEvmAdapter,
      fakeBchClient,
      solverEvmKey,
      sampleWif,
    );

    const config = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      solverBchWif: sampleWif,
      baseHtlcAddress: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      operatorToken,
      allowMockPaylinkSignatures: true,
    });

    app = buildServer({
      config,
      db,
      bchClient: fakeBchClient,
      evmAdapter: fakeEvmAdapter,
      engine,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (db) db.close();
  });

  it('GET /v1/health returns timestamp in Unix seconds within 10s of now', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const parsed = HealthResponseSchema.parse(body);

    assertTimestampSeconds(parsed.timestamp, 'health.timestamp', 10);
  });

  it('POST /v1/quotes and GET /v1/orders/:id return all timestamps in Unix seconds', async () => {
    const quotePayload = {
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      counterChain: 'base' as const,
      counterSymbol: 'USDC' as const,
      amountIn: '10000000',
      userCounterAddress: '0x1111111111111111111111111111111111111111',
      userBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
      hashLock: `0x${'33'.repeat(32)}` as const,
      lane: 'safe' as const,
    };

    const quoteRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quotePayload,
    });
    expect(quoteRes.statusCode).toBe(200);
    const quoteBody = JSON.parse(quoteRes.body);
    const parsedQuote = QuoteResponseSchema.parse(quoteBody);

    assertTimestampSeconds(
      parsedQuote.terms.quoteExpiry,
      'quote.terms.quoteExpiry',
      86400,
    );
    assertTimestampSeconds(
      parsedQuote.terms.counterDeadline,
      'quote.terms.counterDeadline',
      86400 * 2,
    );

    // Query order status: GET /v1/orders/:id
    const orderRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${parsedQuote.orderId}`,
    });
    expect(orderRes.statusCode).toBe(200);
    const orderBody = JSON.parse(orderRes.body);
    const parsedOrder = OrderStatusResponseSchema.parse(orderBody);

    assertTimestampSeconds(parsedOrder.updatedAt, 'order.updatedAt', 10);
    assertTimestampSeconds(
      parsedOrder.deadlines.quoteExpiry,
      'order.deadlines.quoteExpiry',
      86400,
    );
    assertTimestampSeconds(
      parsedOrder.deadlines.counterDeadline,
      'order.deadlines.counterDeadline',
      86400 * 2,
    );
  });

  it('GET /v1/orders/:id normalizes legacy database millisecond timestamps to seconds', async () => {
    // Inject an order directly with millisecond timestamps into DB (simulating legacy data)
    const quotePayload = {
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      counterChain: 'base' as const,
      counterSymbol: 'USDC' as const,
      amountIn: '5000000',
      userCounterAddress: '0x2222222222222222222222222222222222222222',
      userBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
      hashLock: `0x${'44'.repeat(32)}` as const,
      lane: 'safe' as const,
    };

    const quoteRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quotePayload,
    });
    const parsedQuote = QuoteResponseSchema.parse(JSON.parse(quoteRes.body));

    // Force raw SQL update with millisecond timestamp (~1.73e12)
    const rawMs = Date.now();
    expect(rawMs).toBeGreaterThan(100_000_000_000);
    db.db
      .prepare('UPDATE orders SET updated_at = ?, created_at = ? WHERE id = ?')
      .run(rawMs, rawMs, parsedQuote.orderId);

    // Verify GET /v1/orders/:id returns Unix seconds and passes schema
    const orderRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${parsedQuote.orderId}`,
    });
    expect(orderRes.statusCode).toBe(200);
    const orderBody = JSON.parse(orderRes.body);
    const parsedOrder = OrderStatusResponseSchema.parse(orderBody);

    assertTimestampSeconds(parsedOrder.updatedAt, 'legacy-updatedAt', 10);
    expect(parsedOrder.updatedAt).toBe(Math.floor(rawMs / 1000));
  });

  it('GET /v1/stats returns asOf in Unix seconds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/stats',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const parsed = StatsSummarySchema.parse(body);

    if (parsed.asOf !== null) {
      assertTimestampSeconds(parsed.asOf, 'stats.asOf', 10);
    }
  });

  it('GET /v1/orders/recent returns settledAt in Unix seconds and durationSeconds', async () => {
    // Create a DONE order in the database
    const orderId = `0x${'55'.repeat(32)}` as const;
    const nowSec = Math.floor(Date.now() / 1000);
    const orderRecord = {
      id: orderId,
      direction: 'COUNTER_TO_BCH' as const,
      status: 'DONE' as const,
      lane: 'safe' as const,
      fastOptIn: false,
      terms: {
        version: 1 as const,
        direction: 'COUNTER_TO_BCH' as const,
        bchToken: 'PUSD' as const,
        bchTokenCategory: `0x${'11'.repeat(32)}` as const,
        bchTokenAmount: 1000n,
        counterAmount: 10000000n,
        counterChain: 'base' as const,
        counterNetworkId: 84532,
        counterAsset: {
          symbol: 'USDC' as const,
          decimals: 6,
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
        counterHtlc: '0x1234567890123456789012345678901234567890',
        userCounterAddress: '0x3333333333333333333333333333333333333333',
        solverCounterAddress: solverAddress,
        userBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
        solverBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
        hashLock: `0x${'55'.repeat(32)}` as const,
        counterDeadline: nowSec + 86400,
        bchRefundHeight: 340000,
        bchCarrySats: 3000n,
        bchMaxFee: 1500n,
        quoteId: 'test-quote-recent',
        quoteExpiry: nowSec + 3600,
      },
      hashLock: `0x${'55'.repeat(32)}` as const,
      userLockTxId: `0x${'aa'.repeat(32)}`,
      solverLockTxId: 'bb'.repeat(32),
      solverClaimTxId: `0x${'cc'.repeat(32)}`,
      userClaimTxId: 'dd'.repeat(32),
      createdAt: nowSec - 120,
      updatedAt: nowSec,
    };
    db.saveOrder(orderRecord);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/orders/recent',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const parsed = RecentSwapsResponseSchema.parse(body);

    expect(parsed.swaps.length).toBeGreaterThan(0);
    const swap = parsed.swaps[0]!;
    assertTimestampSeconds(swap.settledAt, 'recentSwap.settledAt', 10);
    expect(typeof swap.durationSeconds).toBe('number');
    expect(swap.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(swap.durationSeconds).toBeLessThan(1000);
  });

  it('POST /v1/links and GET /v1/links/:id return createdAt and expiresAt in Unix seconds', async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 7200;
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: 'bchtest:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
        recipientLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        token: 'PUSD',
        amountOut: '5000000',
        expiresAt: futureExpiry,
        memo: 'Time test link',
      },
    });
    expect(createRes.statusCode).toBe(200);
    const createBody = JSON.parse(createRes.body);
    const parsedLink = PayLinkSchema.parse(createBody);

    assertTimestampSeconds(parsedLink.createdAt, 'paylink.createdAt', 10);
    assertTimestampSeconds(parsedLink.expiresAt, 'paylink.expiresAt', 86400);

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/links/${parsedLink.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const getBody = JSON.parse(getRes.body);
    const parsedGetLink = PayLinkSchema.parse(getBody);

    assertTimestampSeconds(
      parsedGetLink.createdAt,
      'paylink-get.createdAt',
      10,
    );
    assertTimestampSeconds(
      parsedGetLink.expiresAt,
      'paylink-get.expiresAt',
      86400,
    );
  });

  it('GET /v1/metrics returns timestamp and lastConfirmedAt in Unix seconds', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    assertTimestampSeconds(body.timestamp, 'metrics.timestamp', 10);
    assertTimestampSeconds(
      body.lastConfirmedTipTimes.bch.lastConfirmedAt,
      'metrics.lastConfirmedTipTimes.bch.lastConfirmedAt',
      120,
    );
  });

  it('GET /v1/operator/needs-attention returns timestamps in Unix seconds', async () => {
    // Flag an order as needs attention
    const orderId = `0x${'66'.repeat(32)}` as const;
    const nowSec = Math.floor(Date.now() / 1000);
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH' as const,
      status: 'SOLVER_LOCK_BROADCAST' as const,
      lane: 'safe' as const,
      fastOptIn: false,
      terms: {
        version: 1 as const,
        direction: 'COUNTER_TO_BCH' as const,
        bchToken: 'PUSD' as const,
        bchTokenCategory: `0x${'11'.repeat(32)}` as const,
        bchTokenAmount: 1000n,
        counterAmount: 10000000n,
        counterChain: 'base' as const,
        counterNetworkId: 84532,
        counterAsset: {
          symbol: 'USDC' as const,
          decimals: 6,
          address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        },
        counterHtlc: '0x1234567890123456789012345678901234567890',
        userCounterAddress: '0x4444444444444444444444444444444444444444',
        solverCounterAddress: solverAddress,
        userBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
        solverBchLockingBytecode: `0x${'a914'.repeat(10)}` as const,
        hashLock: `0x${'66'.repeat(32)}` as const,
        counterDeadline: nowSec + 86400,
        bchRefundHeight: 340000,
        bchCarrySats: 3000n,
        bchMaxFee: 1500n,
        quoteId: 'test-quote-attention',
        quoteExpiry: nowSec + 3600,
      },
      hashLock: `0x${'66'.repeat(32)}` as const,
      needsAttention: true,
      rejectionReason: 'Test needs attention reason',
      createdAt: nowSec - 300,
      updatedAt: nowSec - 50,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    assertTimestampSeconds(body.timestamp, 'operator.timestamp', 10);
    expect(body.orders.length).toBeGreaterThan(0);
    const attentionOrder = body.orders.find(
      (o: { orderId: string }) => o.orderId === orderId,
    );
    expect(attentionOrder).toBeDefined();

    assertTimestampSeconds(
      attentionOrder.createdAt,
      'attentionOrder.createdAt',
      600,
    );
    assertTimestampSeconds(
      attentionOrder.updatedAt,
      'attentionOrder.updatedAt',
      600,
    );
    expect(typeof attentionOrder.ageSeconds).toBe('number');
    expect(attentionOrder.ageSeconds).toBeGreaterThanOrEqual(290);
  });
});
