import { describe, it, expect, beforeEach } from 'vitest';
import { SolverDatabase } from '../src/db/database.js';
import { buildServer, ErrorMetricsTracker } from '../src/api/server.js';
import { SolverConfigSchema } from '../src/config.js';
import { sha256 } from 'viem';
import type { SolverOrderRecord } from '../src/state-machine/types.js';
import { parseOrderTerms } from '@ferry/core';
import type { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { SolverEngine } from '../src/engine/runner.js';

describe('Solver Metrics & Operator Alerts API', () => {
  let db: SolverDatabase;
  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

  const fakeEvmAdapter = {
    getTip: async () => ({ height: 21854320, ageSeconds: 5, stale: false }),
  } as unknown as EvmChainAdapter & {
    getTip: () => Promise<{
      height: number;
      ageSeconds: number;
      stale: boolean;
    }>;
  };

  const fakeBchClient = {
    getQuorumStatus: () => ({
      isQuorumHealthy: true,
      quorumTip: 330050,
      tips: { 'server-1': 330050, 'server-2': 330050 },
      ageSeconds: 120,
      lastConfirmedAt: Math.floor(Date.now() / 1000) - 120,
    }),
  } as unknown as BchQuorumClient;

  const engine = {
    start: async () => {},
    stop: () => {},
    handleEvent: async () => {},
  } as unknown as SolverEngine;

  beforeEach(() => {
    db = new SolverDatabase(':memory:');
  });

  function makeTestTerms(opts: {
    direction?: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
    counterAmount?: bigint;
    bchTokenAmount?: bigint;
    hashLock: `0x${string}`;
    quoteExpiry?: number;
  }) {
    return parseOrderTerms({
      version: 1,
      direction: opts.direction ?? 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'aa'.repeat(32)}`,
      bchTokenAmount: opts.bchTokenAmount ?? 24_8500n,
      counterAmount: opts.counterAmount ?? 25_000_000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      solverCounterAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      userBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac',
      solverBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      hashLock: opts.hashLock,
      counterDeadline: 1800086400,
      bchRefundHeight: 330000,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: `test-quote-${Math.random()}`,
      quoteExpiry: opts.quoteExpiry ?? Math.floor(Date.now() / 1000) + 60,
    });
  }

  const seedSampleOrders = (now: number = Math.floor(Date.now() / 1000)) => {
    // 1. Quoted order
    const quotedOrder: SolverOrderRecord = {
      id: '0xquoted-1',
      direction: 'COUNTER_TO_BCH',
      status: 'QUOTED',
      terms: makeTestTerms({
        direction: 'COUNTER_TO_BCH',
        counterAmount: 25_000_000n, // $25.00
        bchTokenAmount: 24_8500n,
        hashLock: sha256('0xsecret1'),
        quoteExpiry: now + 60,
      }),
      hashLock: sha256('0xsecret1'),
      createdAt: now - 30,
      updatedAt: now - 30,
    };
    db.saveOrder(quotedOrder);

    // 2. Active order: USER_LOCK_SEEN
    const activeOrder: SolverOrderRecord = {
      id: '0xactive-1',
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_SEEN',
      terms: makeTestTerms({
        direction: 'COUNTER_TO_BCH',
        counterAmount: 50_000_000n, // $50.00
        bchTokenAmount: 49_7500n,
        hashLock: sha256('0xsecret2'),
        quoteExpiry: now + 60,
      }),
      hashLock: sha256('0xsecret2'),
      createdAt: now - 120, // 2 minutes ago (oldest non-terminal)
      updatedAt: now - 100,
    };
    db.saveOrder(activeOrder);

    // 3. Needs-attention order with private secret
    const sampleSecret3 =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const;
    const sampleHashLock3 = sha256(sampleSecret3);
    const alertOrder: SolverOrderRecord = {
      id: '0xalert-1',
      direction: 'BCH_TO_COUNTER',
      status: 'REJECTED',
      needsAttention: true,
      rejectionReason:
        'Reconciliation: EVM lock is claimed unexpectedly early; marking needs_attention',
      secret: sampleSecret3,
      terms: makeTestTerms({
        direction: 'BCH_TO_COUNTER',
        counterAmount: 10_000_000n,
        bchTokenAmount: 9_9000n,
        hashLock: sampleHashLock3,
        quoteExpiry: now - 100,
      }),
      hashLock: sampleHashLock3,
      userLockTxId: '0xuser-bch-txid-1234',
      createdAt: now - 300,
      updatedAt: now - 50,
    };
    db.saveOrder(alertOrder);

    // 4. Settled order: DONE
    const doneOrder: SolverOrderRecord = {
      id: '0xdone-1',
      direction: 'COUNTER_TO_BCH',
      status: 'DONE',
      terms: makeTestTerms({
        direction: 'COUNTER_TO_BCH',
        counterAmount: 20_000_000n,
        bchTokenAmount: 19_8000n,
        hashLock: sha256('0xsecret4'),
        quoteExpiry: now - 200,
      }),
      hashLock: sha256('0xsecret4'),
      createdAt: now - 400,
      updatedAt: now - 350,
    };
    db.saveOrder(doneOrder);
  };

  it('GET /v1/metrics returns comprehensive operational metrics with zero secrets', async () => {
    seedSampleOrders();
    const config = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      maxExposureUsdMicros: 250_000_000n,
      maxGlobalUnfundedQuotes: 500,
      maxUnfundedQuotesPerAddress: 10,
    });

    const errorTracker = new ErrorMetricsTracker();
    const app = buildServer({
      config,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
      errorTracker,
    });

    // Generate an error to verify error tracking
    await app.inject({
      method: 'GET',
      url: '/v1/orders/0xnonexistent',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);

    // 1. Order counts by status
    expect(body.orderCounts).toBeDefined();
    expect(body.orderCounts.QUOTED).toBe(1);
    expect(body.orderCounts.USER_LOCK_SEEN).toBe(1);
    expect(body.orderCounts.REJECTED).toBe(1);
    expect(body.orderCounts.DONE).toBe(1);
    expect(body.orderCounts.EXPIRED).toBe(0);

    // 2. Oldest non-terminal order age
    expect(body.oldestNonTerminalOrderAgeSeconds).toBeGreaterThanOrEqual(119);

    // 3. Exposure
    expect(body.exposure.usdMicros).toBe('50000000'); // only USER_LOCK_SEEN counts ($50)
    expect(body.exposure.usdFormatted).toBe('$50.00');
    expect(body.exposure.capUsdMicros).toBe('250000000');
    expect(body.exposure.capUsdFormatted).toBe('$250.00');

    // 4. Unfunded quotes
    expect(body.unfundedQuotes.count).toBe(1);
    expect(body.unfundedQuotes.capGlobal).toBe(500);
    expect(body.unfundedQuotes.capPerAddress).toBe(10);

    // 5. Last confirmed tip times
    expect(body.lastConfirmedTipTimes.base.height).toBe(21854320);
    expect(body.lastConfirmedTipTimes.base.ageSeconds).toBe(5);
    expect(body.lastConfirmedTipTimes.base.stale).toBe(false);
    expect(body.lastConfirmedTipTimes.bch.height).toBe(330050);
    expect(body.lastConfirmedTipTimes.bch.ageSeconds).toBe(120);
    expect(body.lastConfirmedTipTimes.bch.quorum).toBe(true);

    // 6. Error counts
    expect(body.errorCounts.total).toBe(1);
    expect(body.errorCounts.byCode.ORDER_NOT_FOUND).toBe(1);
    expect(body.errorCounts.lastError.code).toBe('ORDER_NOT_FOUND');

    // 7. Needs-attention counts (aggregate count only, zero orders array in public metrics)
    expect(body.needsAttention.count).toBe(1);
    expect(body.needsAttention.orders).toBeUndefined();

    // 8. STRICT PRIVACY ENFORCEMENT: public metrics never include order IDs, addresses, or secrets
    expect(res.payload).not.toContain('0xquoted-1');
    expect(res.payload).not.toContain('0xactive-1');
    expect(res.payload).not.toContain('0xalert-1');
    expect(res.payload).not.toContain('0xdone-1');
    expect(res.payload).not.toContain('"orderId"');
    expect(res.payload).not.toContain(
      '0x1111111111111111111111111111111111111111',
    );
    expect(res.payload).not.toContain(
      '0x2222222222222222222222222222222222222222',
    );
    expect(res.payload).not.toContain(
      '0x3333333333333333333333333333333333333333',
    );
    expect(res.payload).not.toContain(
      '0x4444444444444444444444444444444444444444',
    );
    expect(res.payload).not.toContain('userCounterAddress');
    expect(res.payload).not.toContain('userBchLockingBytecode');
    expect(res.payload).not.toContain(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
    expect(res.payload).not.toContain('secret');
  });

  it('GET /v1/operator/needs-attention requires valid Bearer token and answers 404 when unset', async () => {
    seedSampleOrders();
    const operatorToken = 'very-secret-operator-token-with-at-least-32-chars';

    // 1. When operatorToken is unset, operator routes answer 404 (hides existence)
    const appWithoutToken = buildServer({
      config: SolverConfigSchema.parse({
        solverEvmPrivateKey: solverEvmKey,
      }),
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    const res404 = await appWithoutToken.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
    });
    expect(res404.statusCode).toBe(404);

    const alias404 = await appWithoutToken.inject({
      method: 'GET',
      url: '/v1/operator/alerts',
    });
    expect(alias404.statusCode).toBe(404);

    // Removed alias /v1/alerts answers 404
    const removedRes = await appWithoutToken.inject({
      method: 'GET',
      url: '/v1/alerts',
    });
    expect(removedRes.statusCode).toBe(404);

    // 2. When operatorToken is set:
    const appWithToken = buildServer({
      config: SolverConfigSchema.parse({
        solverEvmPrivateKey: solverEvmKey,
        operatorToken,
      }),
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    // 2a. Missing Authorization header -> 401
    const resNoAuth = await appWithToken.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
    });
    expect(resNoAuth.statusCode).toBe(401);
    expect(JSON.parse(resNoAuth.payload).code).toBe('UNAUTHORIZED');

    // 2b. Malformed Authorization header -> 401
    const resBadScheme = await appWithToken.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
      headers: {
        authorization: 'Basic dXNlcjpwYXNz',
      },
    });
    expect(resBadScheme.statusCode).toBe(401);
    expect(JSON.parse(resBadScheme.payload).code).toBe('UNAUTHORIZED');

    // 2c. Wrong token -> 401
    const resWrongToken = await appWithToken.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
      headers: {
        authorization:
          'Bearer incorrect-token-that-is-at-least-32-chars-long-12345',
      },
    });
    expect(resWrongToken.statusCode).toBe(401);
    expect(JSON.parse(resWrongToken.payload).code).toBe('UNAUTHORIZED');

    // 2d. Correct token -> 200 with orders
    const resOk = await appWithToken.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });
    expect(resOk.statusCode).toBe(200);
    const body = JSON.parse(resOk.payload);
    expect(body.count).toBe(1);
    expect(body.orders[0].orderId).toBe('0xalert-1');
    expect(body.orders[0].direction).toBe('BCH_TO_COUNTER');
    expect(body.orders[0].rejectionReason).toContain(
      'EVM lock is claimed unexpectedly early',
    );
    expect(body.orders[0].txIds.userLockTxId).toBe('0xuser-bch-txid-1234');
    expect(body.systemAlerts).toBeDefined();

    // 2e. Alias /v1/operator/alerts also accepts Bearer token and returns same payload
    const aliasOk = await appWithToken.inject({
      method: 'GET',
      url: '/v1/operator/alerts',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });
    expect(aliasOk.statusCode).toBe(200);
    const aliasBody = JSON.parse(aliasOk.payload);
    expect(aliasBody.count).toBe(body.count);

    // 2f. Removed alias /v1/alerts still returns 404 even with valid token
    const removedWithToken = await appWithToken.inject({
      method: 'GET',
      url: '/v1/alerts',
      headers: {
        authorization: `Bearer ${operatorToken}`,
      },
    });
    expect(removedWithToken.statusCode).toBe(404);

    // Strict privacy: no raw preimage secret in operator payload
    expect(resOk.payload).not.toContain(
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    );
  });

  it('verifies public routes never include order IDs', async () => {
    seedSampleOrders();
    const config = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
    });

    const app = buildServer({
      config,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    // Check all public informational endpoints
    const publicUrls = [
      '/v1/metrics',
      '/v1/health',
      '/v1/stats',
      '/v1/orders/recent',
      '/v1/pegs',
    ];

    for (const url of publicUrls) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);

      // Verify none of the seeded order IDs are present in any public endpoint
      expect(res.payload).not.toContain('0xquoted-1');
      expect(res.payload).not.toContain('0xactive-1');
      expect(res.payload).not.toContain('0xalert-1');
      expect(res.payload).not.toContain('0xdone-1');
    }
  });

  it('fails closed on mainnet if trustedProxy is unset while forwarding header is present', async () => {
    const mainnetConfig = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      network: 'mainnet',
      trustedProxy: false, // operator did not enable trustedProxy!
      operatorToken: 'a'.repeat(32), // valid 32-char token
    });

    const app = buildServer({
      config: mainnetConfig,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    // Request arrives with X-Forwarded-For header on mainnet without trustedProxy
    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: {
        'x-forwarded-for': '198.51.100.22',
      },
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '25000000',
        lane: 'safe',
        userCounterAddress: '0x1111111111111111111111111111111111111111',
        userBchLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        hashLock: sha256('0xsome_hashlock_value'),
      },
    });

    // Must fail closed with 400 and typed code UNTRUSTED_PROXY_HEADER
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('UNTRUSTED_PROXY_HEADER');
    expect(body.message).toContain(
      'rejected on mainnet when TRUSTED_PROXY is disabled',
    );
  });

  it('allows forwarding headers on mainnet when trustedProxy is enabled', async () => {
    const mainnetConfig = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      network: 'mainnet',
      trustedProxy: true, // operator correctly configured trustedProxy!
      operatorToken: 'a'.repeat(32), // valid 32-char token
    });

    const app = buildServer({
      config: mainnetConfig,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: {
        'x-forwarded-for': '198.51.100.22',
      },
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '25000000',
        lane: 'safe',
        userCounterAddress: '0x1111111111111111111111111111111111111111',
        userBchLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        hashLock: sha256('0xsome_hashlock_value_2'),
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.orderId).toBeDefined();
  });

  describe('Mainnet OPERATOR_TOKEN Enforcement', () => {
    it('refuses mainnet config if operatorToken is missing', () => {
      expect(() =>
        SolverConfigSchema.parse({
          solverEvmPrivateKey: solverEvmKey,
          network: 'mainnet',
        }),
      ).toThrowError(/OPERATOR_TOKEN with at least 32 characters is required/);
    });

    it('refuses mainnet config if operatorToken is shorter than 32 characters', () => {
      expect(() =>
        SolverConfigSchema.parse({
          solverEvmPrivateKey: solverEvmKey,
          network: 'mainnet',
          operatorToken: 'short-token-under-32-chars',
        }),
      ).toThrowError();
    });

    it('accepts mainnet config when operatorToken has at least 32 characters', () => {
      const config = SolverConfigSchema.parse({
        solverEvmPrivateKey: solverEvmKey,
        network: 'mainnet',
        operatorToken: 'valid-32-char-token-for-mainnet!',
      });
      expect(config.operatorToken).toBe('valid-32-char-token-for-mainnet!');
    });
  });
});
