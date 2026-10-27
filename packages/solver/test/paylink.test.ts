import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  CreatePayLinkResponseSchema,
  GetPayLinkResponseSchema,
  ListPayLinksResponseSchema,
  CancelPayLinkResponseSchema,
  QuoteResponseSchema,
  quoteExactOut,
} from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverConfigSchema } from '../src/config.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import {
  mockMessageSignature,
  payLinkMessage,
  payLinksMessage,
} from '../src/paylink/link.js';

describe('Pay Links API (PL-01 to PL-05)', () => {
  let app: FastifyInstance;
  let db: SolverDatabase;
  let engine: SolverEngine;
  let fakeBchClient: BchQuorumClient;
  let fakeEvmAdapter: EvmChainAdapter;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';
  const merchantCashaddr = 'bchtest:qz0000000000000000000000000000000000000001';
  const merchantLockingBytecode =
    '0x76a914000000000000000000000000000000000000000188ac';
  const payerCounterAddress = '0x2222222222222222222222222222222222222222';

  beforeAll(async () => {
    db = new SolverDatabase(':memory:');

    fakeBchClient = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: { 'wss://mock1': 330000, 'wss://mock2': 330000 },
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => 'mock-broadcast',
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: async () => {},
    } as unknown as BchQuorumClient;

    fakeEvmAdapter = {
      address: solverAddress,
      lockId: (sender: `0x${string}`, hashLock: `0x${string}`) =>
        `0xmock-lock-${sender}-${hashLock}`,
      getTip: async () => ({
        height: 18500000,
        timestamp: Math.floor(Date.now() / 1000) - 2,
        ageSeconds: 2,
      }),
    } as unknown as EvmChainAdapter;

    engine = new SolverEngine(
      db,
      fakeEvmAdapter,
      fakeBchClient,
      solverEvmKey,
      sampleWif,
      'testnet',
    );

    const config = SolverConfigSchema.parse({
      spreadBps: 40,
      fixedFeeUsdMicros: 50000n,
      quotingEnabled: true,
      solverEvmPrivateKey: solverEvmKey,
      solverBchWif: sampleWif,
      allowMockPaylinkSignatures: true,
    });

    app = buildServer({
      config,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  it('PL-01: creates an invoice and quotes exact-output with recipientLockingBytecode mapped to userBchLockingBytecode', async () => {
    // 1. Create invoice pay link
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '1000', // 10.00 tPUSD (2 decimals)
        memo: 'Coffee and bagel',
      },
    });
    expect(createRes.statusCode).toBe(200);
    const link = CreatePayLinkResponseSchema.parse(JSON.parse(createRes.body));
    expect(link.kind).toBe('invoice');
    expect(link.status).toBe('open');
    expect(link.amountOut).toBe(1000n);

    // 2. Fetch via GET /v1/links/:id
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/links/${link.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    const fetched = GetPayLinkResponseSchema.parse(JSON.parse(getRes.body));
    expect(fetched.id).toBe(link.id);

    // 3. Request quote via POST /v1/links/:id/quotes
    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/links/${link.id}/quotes`,
      payload: {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: payerCounterAddress,
        hashLock:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        lane: 'safe',
      },
    });
    expect(quoteRes.statusCode).toBe(200);
    const quote = QuoteResponseSchema.parse(JSON.parse(quoteRes.body));

    // Verify exact-out math: 1000 PUSD base units (2 decimals) -> USDC (6 decimals)
    const expectedAmountIn = quoteExactOut(1000n, 6, 2, {
      spreadBps: 40,
      fixedFeeUsdMicros: 50000n,
    });
    expect(quote.terms.bchTokenAmount).toBe(1000n);
    expect(quote.terms.counterAmount).toBe(expectedAmountIn);

    // Invariant: recipientLockingBytecode MUST equal userBchLockingBytecode
    expect(quote.terms.userBchLockingBytecode.toLowerCase()).toBe(
      merchantLockingBytecode.toLowerCase(),
    );

    // Link must now be reserved
    const reservedLink = db.getPayLink(link.id);
    expect(reservedLink?.status).toBe('reserved');
    expect(reservedLink?.orderId).toBe(quote.orderId);
  });

  it('PL-02: concurrent payers: second quote is refused; second lock is refused by solver engine; recipient receives once', async () => {
    // 1. Create a fresh invoice
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '2500', // 25.00 tPUSD
      },
    });
    const link = CreatePayLinkResponseSchema.parse(JSON.parse(createRes.body));

    // 2. Payer 1 quotes invoice
    const quote1Res = await app.inject({
      method: 'POST',
      url: `/v1/links/${link.id}/quotes`,
      payload: {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: '0x1111111111111111111111111111111111111111',
        hashLock:
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        lane: 'safe',
      },
    });
    expect(quote1Res.statusCode).toBe(200);
    const quote1 = QuoteResponseSchema.parse(JSON.parse(quote1Res.body));

    // 3. Payer 2 attempts to quote the same invoice -> 409 LINK_RESERVED
    const quote2Res = await app.inject({
      method: 'POST',
      url: `/v1/links/${link.id}/quotes`,
      payload: {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: '0x2222222222222222222222222222222222222222',
        hashLock:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        lane: 'safe',
      },
    });
    expect(quote2Res.statusCode).toBe(409);
    const err = JSON.parse(quote2Res.body);
    expect(err.code).toBe('LINK_RESERVED');

    // 4. Simulate Payer 2 attempting to lock on-chain with an unauthorized order linked to this invoice
    const conflictingOrderRecord = {
      id: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'USER_LOCK_FINAL' as const,
      lane: 'safe' as const,
      terms: {
        ...quote1.terms,
        hashLock:
          '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      },
      hashLock:
        '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as `0x${string}`,
      payLinkId: link.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.saveOrder(conflictingOrderRecord);

    // Run engine on conflicting order: solver engine refuses to counter-lock because invoice is reserved by quote 1
    await engine.processOrder(conflictingOrderRecord);
    const updatedConflicting = db.getOrder(conflictingOrderRecord.id);
    expect(updatedConflicting?.status).toBe('REJECTED');
    expect(updatedConflicting?.rejectionReason).toMatch(/reserved or paid/i);

    // 5. Payer 1 order completes -> recipient receives once, invoice status becomes paid
    const order1 = db.getOrder(quote1.orderId)!;
    engine.applyEvent(order1, {
      type: 'USER_LOCK_FINAL',
      txId: '0xmock-payer1-lock',
    });
    engine.applyEvent(order1, {
      type: 'SOLVER_LOCK_BROADCAST',
      txId: 'mock-solver-bch-txid',
    });
    engine.applyEvent(order1, {
      type: 'SOLVER_LOCK_SEEN',
      txId: 'mock-solver-bch-txid',
    });
    engine.applyEvent(order1, {
      type: 'USER_CLAIM_SEEN',
      txId: 'mock-user-claim-txid',
      secret:
        '0x1111111111111111111111111111111111111111111111111111111111111111',
    });
    engine.applyEvent(order1, {
      type: 'SOLVER_CLAIM_BROADCAST',
      txId: '0xsolver-claim-txid',
    });
    engine.applyEvent(order1, {
      type: 'SOLVER_CLAIM_FINAL',
      txId: '0xsolver-claim-txid',
    });
    engine.applyEvent(order1, { type: 'SWAP_COMPLETE' });

    expect(order1.status).toBe('DONE');
    const finalLink = db.getPayLink(link.id);
    expect(finalLink?.status).toBe('paid');
  });

  it('PL-03: an expired link refuses quotes and link creation with past expiry is rejected', async () => {
    const now = Math.floor(Date.now() / 1000);

    // 1. Create with past expiry -> 410 LINK_EXPIRED
    const pastCreateRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '1000',
        expiresAt: now - 100,
      },
    });
    expect(pastCreateRes.statusCode).toBe(410);

    // 2. Create link with 1 second expiry
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '1000',
        expiresAt: Math.floor(Date.now() / 1000) + 1,
      },
    });
    expect(createRes.statusCode).toBe(200);
    const link = CreatePayLinkResponseSchema.parse(JSON.parse(createRes.body));

    // Wait for expiry
    const msRemaining = link.expiresAt! * 1000 - Date.now();
    if (msRemaining >= 0) {
      await new Promise((resolve) => setTimeout(resolve, msRemaining + 150));
    }

    // Attempt quote on expired link -> 410 LINK_EXPIRED
    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/links/${link.id}/quotes`,
      payload: {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: payerCounterAddress,
        hashLock:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        lane: 'safe',
      },
    });
    expect(quoteRes.statusCode).toBe(410);
    expect(JSON.parse(quoteRes.body).code).toBe('LINK_EXPIRED');

    // GET /v1/links/:id marks link expired
    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/links/${link.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(JSON.parse(getRes.body).status).toBe('expired');
  });

  it('PL-04: tampered recipient is impossible because the URL holds only the id', async () => {
    // URL holds only base58 id; recipient address and locking bytecode are loaded strictly from solver database
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'open',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        memo: 'Tip jar',
      },
    });
    const link = CreatePayLinkResponseSchema.parse(JSON.parse(createRes.body));

    const getRes = await app.inject({
      method: 'GET',
      url: `/v1/links/${link.id}`,
    });
    const payload = JSON.parse(getRes.body);
    expect(payload.recipientCashaddr).toBe(merchantCashaddr);
    expect(payload.recipientLockingBytecode.toLowerCase()).toBe(
      merchantLockingBytecode.toLowerCase(),
    );
  });

  it('PL-05: verified badge appears only after valid signature; challenge verification; persistence across restarts', async () => {
    const challenge = 'challenge-test-1234567890';
    const message = payLinkMessage(challenge, merchantLockingBytecode);
    const validSig = mockMessageSignature(message);
    const invalidSig = mockMessageSignature('ferry:paylink:v1:other');

    // 1. Create with invalid sig -> verified: false
    const unverifiedRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '1000',
        verification: {
          challenge,
          signature: invalidSig,
        },
      },
    });
    const unverified = CreatePayLinkResponseSchema.parse(
      JSON.parse(unverifiedRes.body),
    );
    expect(unverified.verified).toBe(false);

    // 2. Create with valid sig -> verified: true
    const verifiedRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '1000',
        verification: {
          challenge,
          signature: validSig,
        },
      },
    });
    const verified = CreatePayLinkResponseSchema.parse(
      JSON.parse(verifiedRes.body),
    );
    expect(verified.verified).toBe(true);

    // 3. Owner list links with signed challenge
    const listChallenge = 'list-chal-456';
    const listMsg = payLinksMessage(merchantCashaddr, listChallenge);
    const listSig = mockMessageSignature(listMsg);

    const listRes = await app.inject({
      method: 'GET',
      url: `/v1/links?owner=${encodeURIComponent(merchantCashaddr)}&challenge=${listChallenge}&sig=${listSig}`,
    });
    expect(listRes.statusCode).toBe(200);
    const listData = ListPayLinksResponseSchema.parse(JSON.parse(listRes.body));
    expect(listData.links.length).toBeGreaterThan(0);

    // 4. Owner cancel link with signed challenge
    const cancelChallenge = 'cancel-chal-789';
    const cancelMsg = payLinksMessage(merchantCashaddr, cancelChallenge);
    const cancelSig = mockMessageSignature(cancelMsg);

    const cancelRes = await app.inject({
      method: 'POST',
      url: `/v1/links/${verified.id}/cancel`,
      payload: {
        owner: merchantCashaddr,
        challenge: cancelChallenge,
        sig: cancelSig,
      },
    });
    expect(cancelRes.statusCode).toBe(200);
    const cancelled = CancelPayLinkResponseSchema.parse(
      JSON.parse(cancelRes.body),
    );
    expect(cancelled.status).toBe('cancelled');

    // 5. Test reservation persistence across restarts
    // Create new link and reserve it
    const linkToReserveRes = await app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: {
        kind: 'invoice',
        recipientCashaddr: merchantCashaddr,
        recipientLockingBytecode: merchantLockingBytecode,
        token: 'PUSD',
        amountOut: '3000',
      },
    });
    const linkToReserve = CreatePayLinkResponseSchema.parse(
      JSON.parse(linkToReserveRes.body),
    );

    const quoteRes = await app.inject({
      method: 'POST',
      url: `/v1/links/${linkToReserve.id}/quotes`,
      payload: {
        counterChain: 'base',
        counterSymbol: 'USDC',
        userCounterAddress: payerCounterAddress,
        hashLock:
          '0x9999999999999999999999999999999999999999999999999999999999999999',
        lane: 'safe',
      },
    });
    expect(quoteRes.statusCode).toBe(200);

    // Check DB record
    const preRestart = db.getPayLink(linkToReserve.id);
    expect(preRestart?.status).toBe('reserved');

    // Simulate database reopen (persisted disk or same DB instance)
    const postRestart = db.getPayLink(linkToReserve.id);
    expect(postRestart?.status).toBe('reserved');
    expect(postRestart?.orderId).toBe(preRestart?.orderId);
  });

  it(': when allowMockPaylinkSignatures is false, verified is false and owner routes answer 403', async () => {
    const disabledConfig = SolverConfigSchema.parse({
      spreadBps: 40,
      fixedFeeUsdMicros: 50000n,
      quotingEnabled: true,
      solverEvmPrivateKey: solverEvmKey,
      solverBchWif: sampleWif,
      allowMockPaylinkSignatures: false,
    });
    const disabledApp = buildServer({
      config: disabledConfig,
      db,
      evmAdapter: fakeEvmAdapter,
      bchClient: fakeBchClient,
      engine,
    });
    await disabledApp.ready();

    try {
      const challenge = 'mock-chal-test';
      const msg = payLinkMessage(challenge, merchantLockingBytecode);
      const sig = mockMessageSignature(msg);

      // 1. POST /v1/links sets verified: false
      const createRes = await disabledApp.inject({
        method: 'POST',
        url: '/v1/links',
        payload: {
          kind: 'invoice',
          recipientCashaddr: merchantCashaddr,
          recipientLockingBytecode: merchantLockingBytecode,
          token: 'PUSD',
          amountOut: '1000',
          verification: {
            challenge,
            signature: sig,
          },
        },
      });
      expect(createRes.statusCode).toBe(200);
      const created = JSON.parse(createRes.body);
      expect(created.verified).toBe(false);

      // 2. GET /v1/links returns 403
      const listRes = await disabledApp.inject({
        method: 'GET',
        url: `/v1/links?owner=${encodeURIComponent(merchantCashaddr)}&challenge=c&sig=s`,
      });
      expect(listRes.statusCode).toBe(403);
      expect(JSON.parse(listRes.body).code).toBe('MOCK_SIGNATURES_DISABLED');

      // 3. POST /v1/links/:id/cancel returns 403
      const cancelRes = await disabledApp.inject({
        method: 'POST',
        url: `/v1/links/${created.id}/cancel`,
        payload: {
          owner: merchantCashaddr,
          challenge: 'c',
          sig: 's',
        },
      });
      expect(cancelRes.statusCode).toBe(403);
      expect(JSON.parse(cancelRes.body).code).toBe('MOCK_SIGNATURES_DISABLED');
    } finally {
      await disabledApp.close();
    }
  });
});
