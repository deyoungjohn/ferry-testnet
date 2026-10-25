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
  let fakeEvmAdapter: EvmChainAdapter;
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
      broadcast: async () => '0xmock-bch-broadcast',
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
});
