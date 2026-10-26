import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  StatsSummarySchema,
  RecentSwapsResponseSchema,
  PegsResponseSchema,
  parseOrderTerms,
  orderId as computeOrderId,
} from '@ferry/core';
import type { OrderTerms } from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.js';
import { SolverDatabase } from '../src/db/database.js';
import { SolverConfigSchema } from '../src/config.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';

describe('Stats, Recent Swaps & Pegs Endpoints', () => {
  let app: FastifyInstance;
  let db: SolverDatabase;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

  beforeAll(async () => {
    db = new SolverDatabase(':memory:');

    const fakeBchClient = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: { 'wss://mock1': 330000, 'wss://mock2': 330000 },
        isQuorumHealthy: true,
        ageSeconds: 10,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => 'mock-broadcast',
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: async () => {},
    } as unknown as BchQuorumClient;

    const fakeEvmAdapter = {
      address: solverAddress,
      getTip: async () => ({
        height: 18500000,
        timestamp: Math.floor(Date.now() / 1000) - 2,
        ageSeconds: 2,
      }),
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(
      db,
      fakeEvmAdapter,
      fakeBchClient,
      solverEvmKey,
      'cU1V...fake',
      'testnet',
    );

    const config = SolverConfigSchema.parse({
      spreadBps: 40,
      fixedFeeUsdMicros: 50000n,
      quotingEnabled: true,
      solverEvmPrivateKey: solverEvmKey,
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

  function createMockTerms(amountUsdc: bigint, idx: number = 0): OrderTerms {
    const hashLockHex = idx.toString(16).padStart(2, '0');
    return parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory:
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
      bchTokenAmount: amountUsdc / 10000n,
      counterAmount: amountUsdc,
      counterChain: 'base',
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x1111111111111111111111111111111111111111',
      userCounterAddress: '0x2222222222222222222222222222222222222222',
      solverCounterAddress: solverAddress,
      userBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      solverBchLockingBytecode:
        '0x76a914222222222222222222222222222222222222222288ac',
      hashLock:
        `0x${hashLockHex}34567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef` as `0x${string}`,
      counterDeadline: 1800000000,
      bchRefundHeight: 330100,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: `mock-q-${idx}-${Math.random()}`,
      quoteExpiry: 1800000000,
    });
  }

  describe('GET /v1/stats', () => {
    it('returns null for numerical metrics when database has no completed swaps', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/stats',
      });
      expect(res.statusCode).toBe(200);

      const parsed = StatsSummarySchema.parse(JSON.parse(res.body));
      expect(parsed.completedSwaps).toBeNull();
      expect(parsed.volumeUsdMicros).toBeNull();
      expect(parsed.medianFastSeconds).toBeNull();
      expect(parsed.asOf).toBeNull();
      expect(parsed.quotePolicy).toEqual({
        spreadBps: 40,
        fixedFeeUsdMicros: 50000n,
      });
    });

    it('accurately calculates completedSwaps, volume, and medianFastSeconds from completed orders', async () => {
      const now = Date.now();

      // Safe swap: $10 (10,000,000 micros), duration 40s
      const terms1 = createMockTerms(10000000n, 1);
      const id1 = computeOrderId(terms1);
      db.saveOrder({
        id: id1,
        direction: 'COUNTER_TO_BCH',
        status: 'DONE',
        lane: 'safe',
        terms: terms1,
        hashLock: terms1.hashLock,
        userLockTxId:
          '0x1111111111111111111111111111111111111111111111111111111111111111',
        solverLockTxId:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: now - 40000,
        updatedAt: now,
      });

      // Fast swap 1: $20 (20,000,000 micros), duration 10s
      const terms2 = createMockTerms(20000000n, 2);
      const id2 = computeOrderId(terms2);
      db.saveOrder({
        id: id2,
        direction: 'COUNTER_TO_BCH',
        status: 'DONE',
        lane: 'fast',
        terms: terms2,
        hashLock: terms2.hashLock,
        userLockTxId:
          '0x2222222222222222222222222222222222222222222222222222222222222222',
        solverLockTxId:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        createdAt: now - 10000,
        updatedAt: now,
      });

      // Fast swap 2: $30 (30,000,000 micros), duration 16s
      const terms3 = createMockTerms(30000000n, 3);
      const id3 = computeOrderId(terms3);
      db.saveOrder({
        id: id3,
        direction: 'COUNTER_TO_BCH',
        status: 'DONE',
        lane: 'fast',
        terms: terms3,
        hashLock: terms3.hashLock,
        userLockTxId:
          '0x3333333333333333333333333333333333333333333333333333333333333333',
        solverLockTxId:
          'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        createdAt: now - 16000,
        updatedAt: now,
      });

      // Non-completed swap: QUOTED $50
      const terms4 = createMockTerms(50000000n, 4);
      const id4 = computeOrderId(terms4);
      db.saveOrder({
        id: id4,
        direction: 'COUNTER_TO_BCH',
        status: 'QUOTED',
        lane: 'fast',
        terms: terms4,
        hashLock: terms4.hashLock,
        createdAt: now - 5000,
        updatedAt: now,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/stats',
      });
      expect(res.statusCode).toBe(200);

      const parsed = StatsSummarySchema.parse(JSON.parse(res.body));
      expect(parsed.completedSwaps).toBe(3);
      expect(parsed.volumeUsdMicros).toBe(60000000n); // $10 + $20 + $30 = $60
      expect(parsed.medianFastSeconds).toBe(13); // (10 + 16) / 2 = 13
      expect(parsed.asOf).toBeGreaterThan(0);
    });
  });

  describe('GET /v1/orders/recent', () => {
    it('returns only sanitized completed swaps with valid on-chain txids', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/orders/recent',
      });
      expect(res.statusCode).toBe(200);

      const parsed = RecentSwapsResponseSchema.parse(JSON.parse(res.body));
      expect(parsed.swaps.length).toBe(3);

      for (const swap of parsed.swaps) {
        expect(swap.baseTxId).toMatch(/^0x[0-9a-fA-F]{64}$/);
        expect(swap.bchTxId).toMatch(/^[0-9a-fA-F]{64}$/);
        expect(swap.durationSeconds).toBeGreaterThanOrEqual(0);
        expect(swap.counterSymbol).toBe('USDC');
        expect(swap.bchSymbol).toBe('PUSD');

        // Privacy rules: never leak secret or extra user address fields
        expect(
          (swap as unknown as Record<string, unknown>).secret,
        ).toBeUndefined();
        expect(
          (swap as unknown as Record<string, unknown>).userCounterAddress,
        ).toBeUndefined();
        expect(
          (swap as unknown as Record<string, unknown>).userBchLockingBytecode,
        ).toBeUndefined();
      }
    });
  });

  describe('GET /v1/pegs', () => {
    it('returns testnet-stub peg metadata without invented live price data', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/pegs',
      });
      expect(res.statusCode).toBe(200);

      const parsed = PegsResponseSchema.parse(JSON.parse(res.body));
      expect(parsed.pegs.length).toBe(2);

      const pusd = parsed.pegs.find((p) => p.token === 'PUSD')!;
      expect(pusd.source).toBe('testnet-stub');
      expect(pusd.priceUsdMicros).toBeNull();
      expect(pusd.points).toEqual([]);
      expect(pusd.asOf).toBeNull();

      const musd = parsed.pegs.find((p) => p.token === 'MUSD')!;
      expect(musd.source).toBe('testnet-stub');
      expect(musd.priceUsdMicros).toBeNull();
      expect(musd.points).toEqual([]);
      expect(musd.asOf).toBeNull();
    });
  });
});
