import { describe, it, expect, beforeAll } from 'vitest';
import { sha256 } from 'viem';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverConfigSchema } from '../src/config.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { payLinksMessage, mockMessageSignature } from '../src/paylink/link.js';
import type { LockState } from '@ferry/core';

describe('Public Solver Endpoints Live Hardening & Input Fuzzing', () => {
  let app: FastifyInstance;
  let db: SolverDatabase;
  let fakeBchClient: BchQuorumClient;
  let fakeEvmAdapter: EvmChainAdapter;
  let engine: SolverEngine;
  let isMockLocked = false;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';

  beforeAll(async () => {
    db = new SolverDatabase(':memory:');

    fakeBchClient = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: { 'wss://mock1': 330000, 'wss://mock2': 330000 },
        isQuorumHealthy: true,
        ageSeconds: 10,
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
      getLock: async () =>
        isMockLocked
          ? {
              status: 'locked' as const,
              lockTx: { chain: 'base' as const, txId: '0xevm-lock' },
              claimTx: { chain: 'base' as const, txId: '0xevm-claim-tx' },
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
      allowDevKeys: true,
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

  describe('1. Global Routing & Payload Resilience', () => {
    it('returns 404 with typed NOT_FOUND code for unknown routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/unknown-endpoint',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('NOT_FOUND');
      expect(body.message).toContain('not found');
      expect(res.payload).not.toContain('stack');
    });

    it('returns 400 with typed BAD_REQUEST for malformed JSON syntax', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { 'content-type': 'application/json' },
        payload: '{ invalid: json syntax',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('BAD_REQUEST');
      expect(res.payload).not.toContain('node_modules');
    });

    it('returns 413 with typed BAD_REQUEST for oversized payloads exceeding body limit', async () => {
      const hugeString = 'x'.repeat(1024 * 1024 * 2); // 2MB
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ huge: hugeString }),
      });
      expect(res.statusCode).toBe(413);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('BAD_REQUEST');
      expect(body.message).toContain('payload exceeds maximum');
      expect(res.payload).not.toContain('stack');
    });
  });

  describe('2. POST /v1/quotes hardening', () => {
    it('returns 400 INVALID_QUOTE_REQUEST for malformed schema or invalid types', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'INVALID_DIRECTION',
          amountIn: 'not-a-number',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('INVALID_QUOTE_REQUEST');
    });

    it('returns 400 DUPLICATE_ORDER when replaying a quote request with duplicate (user, hashLock)', async () => {
      const secret =
        '0x1234567890123456789012345678901234567890123456789012345678901234' as const;
      const hashLock = sha256(secret);
      const quotePayload = {
        direction: 'COUNTER_TO_BCH',
        bchToken: 'PUSD',
        counterChain: 'base',
        counterSymbol: 'USDC',
        amountIn: '10000000',
        userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        userBchLockingBytecode:
          '0x76a914222222222222222222222222222222222222222288ac',
        hashLock,
        lane: 'safe',
      };

      const res1 = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: quotePayload,
      });
      expect(res1.statusCode).toBe(200);

      const res2 = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: quotePayload,
      });
      expect(res2.statusCode).toBe(400);
      const body2 = JSON.parse(res2.payload);
      expect(body2.code).toBe('DUPLICATE_ORDER');
    });
  });

  describe('3. GET /v1/orders/:id and POST /v1/orders/:id/secret hardening', () => {
    it('returns 404 ORDER_NOT_FOUND for non-existent order id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orders/0xnonexistent',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).code).toBe('ORDER_NOT_FOUND');
    });

    it('returns 400 INVALID_SECRET_REQUEST for malformed secret length in reveal', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/orders/0xnonexistent/secret',
        payload: { secret: '0x1234' },
      });
      expect(res.statusCode).toBe(404); // Order checked first
    });

    it('returns 400 HASH_LOCK_MISMATCH when secret does not match hashLock', async () => {
      const secret =
        '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914333333333333333333333333333333333333333388ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      const revealRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/secret`,
        payload: {
          secret:
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      });
      expect(revealRes.statusCode).toBe(400);
      expect(JSON.parse(revealRes.payload).code).toBe('HASH_LOCK_MISMATCH');
    });

    it('returns 400 REVEAL_POLICY_REJECTED for out-of-order reveal before locks are confirmed', async () => {
      const secret =
        '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914555555555555555555555555555555555555555588ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      // Lock is absent on chain
      isMockLocked = false;
      const revealRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/secret`,
        payload: { secret },
      });
      expect(revealRes.statusCode).toBe(400);
      expect(JSON.parse(revealRes.payload).code).toBe('REVEAL_POLICY_REJECTED');
    });
  });

  describe('4. POST /v1/orders/:id/relay-lock hardening', () => {
    it('returns 400 UNSUPPORTED_ROUTE when relay-lock is called on a reverse (BCH_TO_COUNTER) swap', async () => {
      const secret =
        '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'BCH_TO_COUNTER',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '1000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914666666666666666666666666666666666666666688ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      const relayRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-lock`,
        payload: {
          owner: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          recipient: solverAddress,
          amount: '10000000',
          hashLock,
          deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
          intentDeadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
          intentSig: '0x' + '11'.repeat(65),
          permitDeadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
          v: 27,
          r: '0x' + '22'.repeat(32),
          s: '0x' + '33'.repeat(32),
        },
      });
      expect(relayRes.statusCode).toBe(400);
      expect(JSON.parse(relayRes.payload).code).toBe('UNSUPPORTED_ROUTE');
    });

    it('returns 409 INVALID_ORDER_STATE when relay-lock is replayed on an already locked order', async () => {
      const secret =
        '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914777777777777777777777777777777777777777788ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      const payload = {
        owner: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
        token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        recipient: solverAddress,
        amount: '10000000',
        hashLock,
        deadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
        intentDeadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
        intentSig: '0x' + '11'.repeat(65),
        permitDeadline: (Math.floor(Date.now() / 1000) + 3600).toString(),
        v: 27,
        r: '0x' + '22'.repeat(32),
        s: '0x' + '33'.repeat(32),
      };

      const res1 = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-lock`,
        payload,
      });
      expect(res1.statusCode).toBe(200);

      // Replayed call
      const res2 = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-lock`,
        payload,
      });
      expect(res2.statusCode).toBe(409);
      expect(JSON.parse(res2.payload).code).toBe('INVALID_ORDER_STATE');
    });
  });

  describe('5. POST /v1/orders/:id/relay-claim hardening', () => {
    it('returns 400 UNSUPPORTED_ROUTE when relay-claim is called on a forward (COUNTER_TO_BCH) swap', async () => {
      const secret =
        '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'COUNTER_TO_BCH',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '10000000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914888888888888888888888888888888888888888888ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      const relayRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-claim`,
        payload: { secret },
      });
      expect(relayRes.statusCode).toBe(400);
      expect(JSON.parse(relayRes.payload).code).toBe('UNSUPPORTED_ROUTE');
    });

    it('returns 409 LOCK_NOT_ACTIVE when EVM lock status is absent', async () => {
      const secret =
        '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'BCH_TO_COUNTER',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '1000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914999999999999999999999999999999999999999988ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;

      isMockLocked = false;
      const relayRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-claim`,
        payload: { secret },
      });
      expect(relayRes.statusCode).toBe(409);
      expect(JSON.parse(relayRes.payload).code).toBe('LOCK_NOT_ACTIVE');
    });

    it('idempotently handles relay-claim when EVM lock was already claimed and order is DONE', async () => {
      const secret =
        '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const;
      const hashLock = sha256(secret);
      const quoteRes = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        payload: {
          direction: 'BCH_TO_COUNTER',
          bchToken: 'PUSD',
          counterChain: 'base',
          counterSymbol: 'USDC',
          amountIn: '1000',
          userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          userBchLockingBytecode:
            '0x76a914999999999999999999999999999999999999999988ac',
          hashLock,
          lane: 'safe',
        },
      });
      const orderId = JSON.parse(quoteRes.payload).orderId;
      const order = db.getOrder(orderId)!;
      order.status = 'DONE';
      db.saveOrder(order);

      // Mock EVM lock status as claimed
      fakeEvmAdapter.getLock = async () =>
        ({
          status: 'claimed' as const,
          lockTx: { chain: 'base' as const, txId: '0xevm-lock' },
          claimTx: { chain: 'base' as const, txId: '0xprev-claim-tx' },
          secret,
          owner: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
          recipient: solverAddress,
          asset: {
            symbol: 'USDC',
            decimals: 6,
            address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          },
          amount: 25000000n,
          hashLock,
          deadline: Math.floor(Date.now() / 1000) + 86400,
        }) as unknown as LockState;

      const relayRes = await app.inject({
        method: 'POST',
        url: `/v1/orders/${orderId}/relay-claim`,
        payload: { secret },
      });
      expect(relayRes.statusCode).toBe(200);
      const body = JSON.parse(relayRes.payload);
      expect(body.orderId).toBe(orderId);
      expect(body.status).toBe('DONE');
    });
  });

  describe('6. Pay-link endpoints input fuzzing & hardening', () => {
    it('returns 400 VALIDATION_ERROR when creating pay-link with invalid cashaddr or empty token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/links',
        payload: {
          kind: 'invoice',
          recipientCashaddr: 'invalid-cash-address',
          recipientLockingBytecode: '0x1234',
          token: 'INVALID_TOKEN',
          amountOut: '100',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 LINK_NOT_FOUND when requesting non-existent link id', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/links/nonexistentlink123',
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).code).toBe('LINK_NOT_FOUND');
    });

    it('returns 400 VALIDATION_ERROR on malformed query parameters for GET /v1/links', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/links?owner=not-valid&challenge=short',
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).code).toBe('VALIDATION_ERROR');
    });

    it('returns 404 LINK_NOT_FOUND on quoting non-existent link', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/links/nonexistentlink123/quotes',
        payload: {
          counterChain: 'base',
          counterSymbol: 'USDC',
          lane: 'safe',
        },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).code).toBe('LINK_NOT_FOUND');
    });

    it('returns 400 INVALID_SIGNATURE on cancel with invalid signature', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/links/nonexistentlink123/cancel',
        payload: {
          owner: 'bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfcp9rvkd',
          challenge:
            '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          sig: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.payload).code).toBe('INVALID_SIGNATURE');
    });

    it('returns 404 LINK_NOT_FOUND on cancelling non-existent link with valid signature', async () => {
      const owner = 'bchtest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqfcp9rvkd';
      const challenge =
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const sig = mockMessageSignature(payLinksMessage(owner, challenge));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/links/nonexistentlink123/cancel',
        payload: {
          owner,
          challenge,
          sig,
        },
      });
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload).code).toBe('LINK_NOT_FOUND');
    });
  });
});
