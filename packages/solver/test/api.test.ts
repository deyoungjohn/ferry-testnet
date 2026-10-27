import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sha256 } from 'viem';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverConfigSchema } from '../src/config.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { FastifyInstance } from 'fastify';

describe('Solver API contracts & Secret Privacy Rule', () => {
  let app: FastifyInstance;
  let db: SolverDatabase;
  let fakeBchClient: BchQuorumClient;
  let fakeEvmAdapter: EvmChainAdapter & {
    getTip: () => Promise<{
      height: number;
      timestamp: number;
      ageSeconds: number;
    }>;
  };
  let engine: SolverEngine;
  let isMockLocked = false;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

  beforeAll(async () => {
    db = new SolverDatabase(':memory:');

    // Create mock BCH client
    fakeBchClient = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: { 'wss://mock1': 330000, 'wss://mock2': 330000 },
        isQuorumHealthy: true,
        ageSeconds: 15,
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

    // Create mock EVM adapter
    isMockLocked = false;
    fakeEvmAdapter = {
      address: solverAddress,
      lockId: (sender: `0x${string}`, hashLock: `0x${string}`) =>
        sha256(`0x${sender.slice(2)}${hashLock.slice(2)}`),
      getLock: async () =>
        isMockLocked
          ? {
              status: 'locked' as const,
              lockTx: { chain: 'base' as const, txId: '0xevm-lock' },
              owner: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
              recipient: solverAddress,
              asset: {
                symbol: 'USDC',
                decimals: 6,
                address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
              },
              amount: 25000000n,
              hashLock: `0x${'7a'.repeat(32)}` as `0x${string}`,
              deadline: Math.floor(Date.now() / 1000) + 86400,
            }
          : { status: 'absent' as const },
      isFinal: async () => true,
      relayLock: async () => ({
        chain: 'base' as const,
        txId: '0xmock-relay-tx',
      }),
      claim: async () => ({ chain: 'base' as const, txId: '0xmock-claim-tx' }),
      refund: async () => ({
        chain: 'base' as const,
        txId: '0xmock-refund-tx',
      }),
      estimateRelayCostUsd: async () => 0.002,
      getTip: async () => ({
        height: 18500000,
        timestamp: Math.floor(Date.now() / 1000) - 2,
        ageSeconds: 2,
      }),
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
    });

    app = buildServer({
      config,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('GET /v1/health returns quorum, tip ages, inventory, and quoting status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.ok).toBe(true);
    expect(body.quoting).toBe(true);
    expect(body.bchTip.height).toBe(330000);
    expect(body.bchTip.quorum).toBe(true);
    expect(body.inventory.length).toBeGreaterThan(0);
  });

  it('POST /v1/quotes generates valid signed quote within bounds', async () => {
    const secret = `0x${'55'.repeat(32)}` as const;
    const hashLock = sha256(secret);

    const quoteReq = {
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: '10000000', // $10.00
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      hashLock,
      lane: 'safe',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteReq,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(body.signerAddress.toLowerCase()).toBe(solverAddress.toLowerCase());
    expect(body.terms.bchTokenAmount).toBe('991'); // $10 - 40bps spread - $0.05 fee = $9.91 -> 991 units
  });

  it('POST /v1/quotes rejects amount out of bounds', async () => {
    const quoteReq = {
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: '500000', // $0.50 (below min $1.00)
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      hashLock: `0x${'55'.repeat(32)}`,
      lane: 'safe',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteReq,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).code).toBe('AMOUNT_OUT_OF_BOUNDS');
  });

  it('ENFORCES SECRET PRIVACY: GET /v1/orders/:id never reveals cooperative secret before on-chain claim', async () => {
    const secret = `0x${'7a'.repeat(32)}` as const;
    const hashLock = sha256(secret);

    // 1. Create a quote
    const quoteRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '25000000',
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914444444444444444444444444444444444444444488ac',
        hashLock,
        lane: 'safe',
      },
    });
    const { orderId } = JSON.parse(quoteRes.payload);

    // Initial order state
    let getRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
    });
    expect(getRes.statusCode).toBe(200);
    let orderData = JSON.parse(getRes.payload);
    expect(orderData.status).toBe('QUOTED');
    expect(orderData.secret).toBeUndefined();

    // Progress order to SOLVER_LOCK_SEEN
    isMockLocked = true;
    const orderRecord = db.getOrder(orderId)!;
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_SEEN',
      txId: '0xevm-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_FINAL',
      txId: '0xevm-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'SOLVER_LOCK_BROADCAST',
      txId: '0xbch-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'SOLVER_LOCK_SEEN',
      txId: '0xbch-lock',
    });

    // 2. Submit cooperative secret reveal via POST /v1/orders/:id/secret
    const revealRes = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/secret`,
      payload: { secret },
    });
    expect(revealRes.statusCode).toBe(200);
    const revealBody = JSON.parse(revealRes.payload);
    expect(revealBody.accepted).toBe(true);
    expect(revealBody.status).toBe('SECRET_KNOWN');

    // 3. STRICT CHECK: GET /v1/orders/:id MUST NOT return secret!
    getRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
    });
    expect(getRes.statusCode).toBe(200);
    orderData = JSON.parse(getRes.payload);
    expect(orderData.status).toBe('SECRET_KNOWN');
    // Secret must NOT be echoed back!
    expect(orderData.secret).toBeUndefined();

    // 4. Once an on-chain claim is confirmed, secretSource becomes 'on_chain_claim'
    engine.applyEvent(orderRecord, {
      type: 'USER_CLAIM_SEEN',
      txId: '0xbch-claim-tx',
      secret,
    });

    getRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${orderId}`,
    });
    expect(getRes.statusCode).toBe(200);
    orderData = JSON.parse(getRes.payload);
    expect(orderData.status).toBe('USER_CLAIM_SEEN');
    // Now it IS public on-chain, so it is included!
    expect(orderData.secret).toBe(secret);
  });

  it('POST /v1/quotes supports reverse direction (BCH_TO_COUNTER) with invariant R and derived solver key', async () => {
    const secret = `0x${'88'.repeat(32)}` as const;
    const hashLock = sha256(secret);

    const quoteReq = {
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      counterChain: 'base',
      counterSymbol: 'USDC',
      amountIn: '1000', // $10.00 (2 decimals: 1000)
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      hashLock,
      lane: 'safe',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: quoteReq,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.orderId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(body.terms.direction).toBe('BCH_TO_COUNTER');
    expect(body.terms.bchTokenAmount).toBe('1000');
    // $10.00 with 40bps spread ($0.04) and $0.05 fixed fee = $9.91 -> 9910000 micros (6 decimals)
    expect(body.terms.counterAmount).toBe('9910000');
    // bchRefundHeight = quorumTip + 144
    expect(body.terms.bchRefundHeight).toBe(330144);
    // solverBchLockingBytecode derived from sampleWif (cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9)
    expect(body.terms.solverBchLockingBytecode).toMatch(/^0x[0-9a-f]+$/);
    expect(body.terms.solverBchLockingBytecode).not.toBe(
      '0x76a914000000000000000000000000000000000000000088ac',
    );
  });

  it('POST /v1/orders/:id/relay-claim relays EVM claim with gas paid by solver', async () => {
    const secret = `0x${'99'.repeat(32)}` as const;
    const hashLock = sha256(secret);

    // 1. Create a reverse quote
    const quoteRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'BCH_TO_COUNTER',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '2500', // $25.00
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914444444444444444444444444444444444444444488ac',
        hashLock,
        lane: 'safe',
      },
    });
    const { orderId } = JSON.parse(quoteRes.payload);
    const orderRecord = db.getOrder(orderId)!;

    // Progress to SOLVER_LOCK_SEEN
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_SEEN',
      txId: '0xbch-user-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'USER_LOCK_FINAL',
      txId: '0xbch-user-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'SOLVER_LOCK_BROADCAST',
      txId: '0xevm-solver-lock',
    });
    engine.applyEvent(orderRecord, {
      type: 'SOLVER_LOCK_SEEN',
      txId: '0xevm-solver-lock',
    });

    // 2. Reject wrong secret
    const badSecretRes = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/relay-claim`,
      payload: { secret: `0x${'11'.repeat(32)}` },
    });
    expect(badSecretRes.statusCode).toBe(400);
    expect(JSON.parse(badSecretRes.payload).code).toBe('HASH_LOCK_MISMATCH');

    // 3. Relay valid claim
    isMockLocked = true;
    const relayRes = await app.inject({
      method: 'POST',
      url: `/v1/orders/${orderId}/relay-claim`,
      payload: { secret },
    });
    expect(relayRes.statusCode).toBe(200);
    const relayBody = JSON.parse(relayRes.payload);
    expect(relayBody.orderId).toBe(orderId);
    expect(relayBody.status).toBe('USER_CLAIM_SEEN');
    expect(relayBody.tx.txId).toBe('0xmock-claim-tx');
  });

  it('POST /v1/quotes enforces fast-lane explicit opt-in and zero-conf cap ($25)', async () => {
    const hashLock = sha256(`0x${'77'.repeat(32)}` as const);

    // 1. Missing fastOptIn
    const noOptInRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'BCH_TO_COUNTER',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '1000', // $10.00
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914444444444444444444444444444444444444444488ac',
        hashLock,
        lane: 'fast',
      },
    });
    expect(noOptInRes.statusCode).toBe(400);
    expect(JSON.parse(noOptInRes.payload).code).toBe(
      'FAST_LANE_OPT_IN_REQUIRED',
    );

    // 2. Exceeds $25 zero-conf cap ($30.00 = 3000 PUSD)
    const capExceededRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'BCH_TO_COUNTER',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '3000', // $30.00 > $25.00
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914444444444444444444444444444444444444444488ac',
        hashLock,
        lane: 'fast',
        fastOptIn: true,
      },
    });
    expect(capExceededRes.statusCode).toBe(400);
    expect(JSON.parse(capExceededRes.payload).code).toBe(
      'FAST_LANE_CAP_EXCEEDED',
    );

    // 3. Valid fast lane ($20.00 = 2000 PUSD, with opt-in)
    const validFastRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'BCH_TO_COUNTER',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '2000', // $20.00 <= $25.00
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914444444444444444444444444444444444444444488ac',
        hashLock,
        lane: 'fast',
        fastOptIn: true,
      },
    });
    expect(validFastRes.statusCode).toBe(200);
    const validFastBody = JSON.parse(validFastRes.payload);
    expect(validFastBody.lane).toBe('fast');
  });

  it('GET /v1/health reports live Base block height and age, and fails closed when RPC is failing or stale', async () => {
    // 1. Healthy state
    const healthRes = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(healthRes.statusCode).toBe(200);
    const health = JSON.parse(healthRes.payload);
    expect(health.counterTips.base.height).toBe(18500000);
    expect(health.counterTips.base.ageSeconds).toBe(2);
    expect(health.counterTips.base.stale).toBe(false);
    expect(health.ok).toBe(true);
    expect(health.quoting).toBe(true);

    // 2. Failing RPC: getTip rejects
    const originalGetTip = fakeEvmAdapter.getTip;
    fakeEvmAdapter.getTip = async () => {
      throw new Error('Connection refused to Base RPC');
    };

    const failingRpcHealthRes = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    expect(failingRpcHealthRes.statusCode).toBe(200);
    const failingHealth = JSON.parse(failingRpcHealthRes.payload);
    expect(failingHealth.counterTips.base.height).toBe(0);
    expect(failingHealth.counterTips.base.stale).toBe(true);
    expect(failingHealth.ok).toBe(false);
    expect(failingHealth.quoting).toBe(false);

    // POST /v1/quotes fails closed with 503 EVM_TIP_UNHEALTHY
    const quoteFailingRpcRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '10000000',
        lane: 'safe',
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        hashLock: sha256(
          '0x8888888888888888888888888888888888888888888888888888888888888888',
        ),
      },
    });
    expect(quoteFailingRpcRes.statusCode).toBe(503);
    expect(JSON.parse(quoteFailingRpcRes.payload).code).toBe(
      'EVM_TIP_UNHEALTHY',
    );

    // 3. Stale tip (ageSeconds = 120 > tipMaxAgeBaseSeconds = 60)
    fakeEvmAdapter.getTip = async () => ({
      height: 18500000,
      timestamp: Math.floor(Date.now() / 1000) - 120,
      ageSeconds: 120,
    });

    const staleRpcHealthRes = await app.inject({
      method: 'GET',
      url: '/v1/health',
    });
    const staleHealth = JSON.parse(staleRpcHealthRes.payload);
    expect(staleHealth.counterTips.base.stale).toBe(true);
    expect(staleHealth.quoting).toBe(false);

    const quoteStaleRpcRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '10000000',
        lane: 'safe',
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914111111111111111111111111111111111111111188ac',
        hashLock: sha256(
          '0x9999999999999999999999999999999999999999999999999999999999999999',
        ),
      },
    });
    expect(quoteStaleRpcRes.statusCode).toBe(503);
    expect(JSON.parse(quoteStaleRpcRes.payload).code).toBe('EVM_TIP_UNHEALTHY');

    // Restore original getTip
    fakeEvmAdapter.getTip = originalGetTip;
  });

  it(': enforces maxExposureUsdMicros cap on POST /v1/quotes and returns 503 EXPOSURE_LIMIT_EXCEEDED', async () => {
    const initialExposure = db.getOpenExposureUsdMicros();
    const testSecret =
      '0x1234123412341234123412341234123412341234123412341234123412341234' as const;
    const testHashLock = sha256(testSecret);

    // Save active order bringing exposure close to cap (leaving $5 margin)
    const fillerAmount = 250_000_000n - initialExposure - 5_000_000n;
    const baseTerms = {
      version: 1 as const,
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as `0x${string}`,
      bchTokenAmount: 24000n,
      counterAmount: fillerAmount,
      counterChain: 'base' as const,
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC' as const,
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const,
      userCounterAddress: '0x1111111111111111111111111111111111111111',
      userBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac' as const,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac' as const,
      hashLock: testHashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-exposure-test',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    };

    db.saveOrder({
      id: '0xexposure_test_order_1',
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      lane: 'safe',
      fastOptIn: false,
      terms: baseTerms,
      hashLock: testHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure + fillerAmount);

    // 2. Request a quote for $20 (20,000,000 micros). (250 - 5) + 20 = 265 > maxExposure (250).
    const overCapRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '20000000', // $20.00
        lane: 'safe',
        userCounterAddress: '0x2222222222222222222222222222222222222222',
        userBchLockingBytecode:
          '0x76a914222222222222222222222222222222222222222288ac',
        hashLock: sha256(
          '0x5555555555555555555555555555555555555555555555555555555555555555',
        ),
      },
    });

    expect(overCapRes.statusCode).toBe(503);
    const overCapBody = JSON.parse(overCapRes.payload);
    expect(overCapBody.code).toBe('EXPOSURE_LIMIT_EXCEEDED');

    // 3. Complete the order to DONE -> exposure drops back to initialExposure
    const o = db.getOrder('0xexposure_test_order_1')!;
    db.saveOrder({ ...o, status: 'DONE' });
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure);

    // 4. Requesting $20 quote now succeeds
    const underCapRes = await app.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '20000000', // $20.00
        lane: 'safe',
        userCounterAddress: '0x2222222222222222222222222222222222222222',
        userBchLockingBytecode:
          '0x76a914222222222222222222222222222222222222222288ac',
        hashLock: sha256(
          '0x6666666666666666666666666666666666666666666666666666666666666666',
        ),
      },
    });
    expect(underCapRes.statusCode).toBe(200);
  });

  it(': transitions abandoned forward QUOTED orders to EXPIRED when quoteExpiry passes', async () => {
    const testSecret =
      '0x9999999999999999999999999999999999999999999999999999999999999999' as const;
    const testHashLock = sha256(testSecret);
    const expiredTerms = {
      version: 1 as const,
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as `0x${string}`,
      bchTokenAmount: 1000n,
      counterAmount: 10_000_000n,
      counterChain: 'base' as const,
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC' as const,
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const,
      userCounterAddress: '0x3333333333333333333333333333333333333333',
      userBchLockingBytecode:
        '0x76a914333333333333333333333333333333333333333388ac' as const,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac' as const,
      hashLock: testHashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-fwd-expiry-test',
      quoteExpiry: Math.floor(Date.now() / 1000) - 10, // Expired 10s ago
    };

    const orderRecord = {
      id: '0xfwd_expiry_test_order',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      lane: 'safe' as const,
      fastOptIn: false,
      terms: expiredTerms,
      hashLock: testHashLock,
      createdAt: Date.now() - 20000,
      updatedAt: Date.now() - 20000,
    };
    db.saveOrder(orderRecord);

    await engine.processOrder(orderRecord);

    const updated = db.getOrder('0xfwd_expiry_test_order');
    expect(updated?.status).toBe('EXPIRED');
  });

  it(': rejects relay-claim on terminal orders with 409 ORDER_TERMINAL', async () => {
    const testSecret =
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
    const testHashLock = sha256(testSecret);
    const terminalTerms = {
      version: 1 as const,
      direction: 'BCH_TO_COUNTER' as const,
      bchToken: 'PUSD' as const,
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as `0x${string}`,
      bchTokenAmount: 1000n,
      counterAmount: 10_000_000n,
      counterChain: 'base' as const,
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC' as const,
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const,
      userCounterAddress: '0x4444444444444444444444444444444444444444',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac' as const,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac' as const,
      hashLock: testHashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 21600,
      bchRefundHeight: 330144,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-terminal-test',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    };

    db.saveOrder({
      id: '0xterminal_order_1',
      direction: 'BCH_TO_COUNTER',
      status: 'REJECTED',
      lane: 'safe',
      fastOptIn: false,
      terms: terminalTerms,
      hashLock: testHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/orders/0xterminal_order_1/relay-claim',
      payload: {
        secret: testSecret,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.payload);
    expect(body.code).toBe('ORDER_TERMINAL');
  });

  it(': unfunded QUOTED orders do not count toward exposure until user lock is seen', async () => {
    const initialExposure = db.getOpenExposureUsdMicros();
    const testSecret =
      '0x3333333333333333333333333333333333333333333333333333333333333333' as const;
    const testHashLock = sha256(testSecret);

    const quoteTerms = {
      version: 1 as const,
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as `0x${string}`,
      bchTokenAmount: 24000n,
      counterAmount: 50_000_000n, // $50.00
      counterChain: 'base' as const,
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC' as const,
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641' as const,
      userCounterAddress: '0x5555555555555555555555555555555555555555',
      userBchLockingBytecode:
        '0x76a914555555555555555555555555555555555555555588ac' as const,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac' as const,
      hashLock: testHashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-unfunded-exposure-test',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    };

    // Save order in QUOTED state
    db.saveOrder({
      id: '0xunfunded_quoted_order',
      direction: 'COUNTER_TO_BCH',
      status: 'QUOTED',
      lane: 'safe',
      fastOptIn: false,
      terms: quoteTerms,
      hashLock: testHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // QUOTED order must NOT increase open exposure
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure);

    // Transition order to USER_LOCK_SEEN -> now counts as exposure
    const o = db.getOrder('0xunfunded_quoted_order')!;
    db.saveOrder({ ...o, status: 'USER_LOCK_SEEN' });
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure + 50_000_000n);

    // Clean up
    db.saveOrder({ ...o, status: 'DONE' });
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure);
  });

  it(': normalizes BSC 18-decimal token amounts to 6-decimal USD micros for exposure', async () => {
    const initialExposure = db.getOpenExposureUsdMicros();
    const testSecret =
      '0x4444444444444444444444444444444444444444444444444444444444444444' as const;
    const testHashLock = sha256(testSecret);

    // BSC USDT with 18 decimals, 25 USDT = 25 * 10^18
    const bsc18Terms = {
      version: 1 as const,
      direction: 'COUNTER_TO_BCH' as const,
      bchToken: 'PUSD' as const,
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac' as `0x${string}`,
      bchTokenAmount: 2485n,
      counterAmount: 25_000_000_000_000_000_000n, // 25 USDT (18 decimals)
      counterChain: 'bsc' as const,
      counterNetworkId: 97,
      counterAsset: {
        symbol: 'USDT' as const,
        decimals: 18,
        address: '0x1111111111111111111111111111111111111111',
      },
      counterHtlc: '0x2222222222222222222222222222222222222222' as const,
      userCounterAddress: '0x6666666666666666666666666666666666666666',
      userBchLockingBytecode:
        '0x76a914666666666666666666666666666666666666666688ac' as const,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac' as const,
      hashLock: testHashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-bsc18-test',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    };

    db.saveOrder({
      id: '0xbsc_18_decimal_order',
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      lane: 'safe',
      fastOptIn: false,
      terms: bsc18Terms,
      hashLock: testHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 25 USDT (18 decimals) must normalize to 25_000_000 USD micros ($25.00), NOT 25e18
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure + 25_000_000n);

    // Clean up
    const o = db.getOrder('0xbsc_18_decimal_order')!;
    db.saveOrder({ ...o, status: 'DONE' });
    expect(db.getOpenExposureUsdMicros()).toBe(initialExposure);
  });

  it(': rate-limits quote requests per address and respects trustedProxy', async () => {
    const testConfig = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      quoteRateLimitWindowMs: 10_000,
      quoteRateLimitMaxPerAddress: 3,
      quoteRateLimitMaxPerIp: 10,
      trustedProxy: false,
    });

    const testApp = buildServer({
      config: testConfig,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    const userAddress = '0x7777777777777777777777777777777777777777';

    // First 3 quote requests succeed
    for (let i = 0; i < 3; i++) {
      const res = await testApp.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          lane: 'safe',
          userCounterAddress: userAddress,
          userBchLockingBytecode:
            '0x76a914777777777777777777777777777777777777777788ac',
          hashLock: sha256(`0x07${i.toString(16).padStart(62, '0')}`),
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 4th request from same address hits rate limit
    const rateLimitedRes = await testApp.inject({
      method: 'POST',
      url: '/v1/quotes',
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '10000000',
        lane: 'safe',
        userCounterAddress: userAddress,
        userBchLockingBytecode:
          '0x76a914777777777777777777777777777777777777777788ac',
        hashLock: sha256(
          '0x07ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        ),
      },
    });

    expect(rateLimitedRes.statusCode).toBe(429);
    const body = JSON.parse(rateLimitedRes.payload);
    expect(body.code).toBe('RATE_LIMITED');
  });

  it(' &: 1,000 quotes from one address do not block a second address', async () => {
    // Isolate in fresh DB and server instance
    const freshDb = new SolverDatabase(':memory:');
    const customConfig = SolverConfigSchema.parse({
      solverEvmPrivateKey: solverEvmKey,
      quoteRateLimitWindowMs: 60_000,
      quoteRateLimitMaxPerAddress: 10,
      quoteRateLimitMaxPerIp: 2000, // allow the 1000 requests to hit address cap
      maxUnfundedQuotesPerAddress: 10,
      maxGlobalUnfundedQuotes: 500,
      maxExposureUsdMicros: 250_000_000n, // $250.00 max exposure
      trustedProxy: true,
    });

    const spamApp = buildServer({
      config: customConfig,
      db: freshDb,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    const spammerAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const innocentAddress = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    let successCount = 0;
    let rateLimitedCount = 0;

    // Spammer sends 1,000 quote requests with distinct hashlocks
    for (let i = 0; i < 1000; i++) {
      const hexPad = i.toString(16).padStart(62, '0');
      const hashLock = sha256(`0x01${hexPad}`);

      const res = await spamApp.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: {
          'x-forwarded-for': '198.51.100.1',
        },
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '25000000', // $25.00 each
          lane: 'safe',
          userCounterAddress: spammerAddress,
          userBchLockingBytecode:
            '0x76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac',
          hashLock,
        },
      });

      if (res.statusCode === 200) {
        successCount++;
      } else if (res.statusCode === 429) {
        rateLimitedCount++;
      }
    }

    // Spammer was bounded to max 10 quotes, remaining 990 were rejected
    expect(successCount).toBe(10);
    expect(rateLimitedCount).toBe(990);

    // Spammer's quotes are unfunded (QUOTED) -> open exposure must still be zero!
    expect(freshDb.getOpenExposureUsdMicros()).toBe(0n);

    // Now, innocent user 2 requests a quote
    const innocentHashLock = sha256(
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    );
    const innocentRes = await spamApp.inject({
      method: 'POST',
      url: '/v1/quotes',
      headers: {
        'x-forwarded-for': '198.51.100.2',
      },
      payload: {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '25000000', // $25.00
        lane: 'safe',
        userCounterAddress: innocentAddress,
        userBchLockingBytecode:
          '0x76a914bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb88ac',
        hashLock: innocentHashLock,
      },
    });

    // Innocent user is NOT blocked: succeeds with 200 OK and valid signed quote!
    expect(innocentRes.statusCode).toBe(200);
    const innocentBody = JSON.parse(innocentRes.payload);
    expect(innocentBody.orderId).toBeDefined();
    expect(innocentBody.signature).toBeDefined();
    expect(innocentBody.terms.userCounterAddress).toBe(innocentAddress);
  }, 30_000);
});
