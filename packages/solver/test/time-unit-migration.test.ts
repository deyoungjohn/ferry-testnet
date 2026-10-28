import { describe, it, expect, afterEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SolverDatabase } from '../src/db/database.js';
import { buildServer } from '../src/api/server.js';
import { SolverConfigSchema } from '../src/config.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { SolverEngine } from '../src/engine/runner.js';
import {
  OrderStatusResponseSchema,
  RecentSwapsResponseSchema,
} from '@ferry/core';

describe('Database Schema Migration v3: Time Unit Normalization', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('fixes SQL sorting inversion and oldest-order age calculation on databases with millisecond rows', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-time-mig-'));
    tmpDirs.push(tmpDir);
    const dbPath = path.join(tmpDir, 'legacy-v2.db');

    // 1. Synthesize a v2 database with millisecond timestamps and a new order in seconds
    const rawDb = new DatabaseConstructor(dbPath);
    rawDb.exec(`
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        direction TEXT NOT NULL,
        status TEXT NOT NULL,
        user_counter_address TEXT NOT NULL,
        lock_id TEXT NOT NULL,
        terms_json TEXT NOT NULL,
        hash_lock TEXT NOT NULL,
        secret TEXT,
        secret_source TEXT,
        user_lock_txid TEXT,
        solver_lock_txid TEXT,
        user_claim_txid TEXT,
        solver_claim_txid TEXT,
        solver_refund_txid TEXT,
        lane TEXT DEFAULT 'safe',
        fast_opt_in INTEGER DEFAULT 0,
        first_seen_at INTEGER,
        needs_attention INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        pay_link_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_counter_address, hash_lock)
      );

      CREATE TABLE pay_links (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        recipient_cashaddr TEXT NOT NULL,
        recipient_locking_bytecode TEXT NOT NULL,
        token TEXT NOT NULL,
        amount_out TEXT,
        min_amount_out TEXT,
        memo TEXT,
        reference TEXT,
        expires_at INTEGER,
        verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        order_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE actions (
        order_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        intent_payload TEXT NOT NULL,
        txid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (order_id, action)
      );

      CREATE INDEX idx_orders_status ON orders(status);
      CREATE INDEX idx_orders_lock_id ON orders(lock_id);
      CREATE INDEX idx_orders_pay_link_id ON orders(pay_link_id);
      CREATE UNIQUE INDEX idx_orders_user_hashlock ON orders(user_counter_address, hash_lock);
      PRAGMA user_version = 2;
    `);

    const termsJson = JSON.stringify({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: '0x' + '11'.repeat(32),
      bchTokenAmount: '1000',
      counterAmount: '10000000',
      counterChain: 'base',
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      userCounterAddress: '0x1234567890123456789012345678901234567890',
      solverCounterAddress: '0x0987654321098765432109876543210987654321',
      counterDeadline: 1793100000,
      bchRefundHeight: 300000,
      userBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac',
      solverBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      bchCarrySats: '1000',
      fastOptIn: false,
    });

    // Old order 1: Created 3 hours ago, stored in milliseconds (~1.793000000000 * 1000)
    const oldMs1 = 1793000000000;
    // Old order 2: Created 1 hour ago, stored in milliseconds
    const oldMs2 = 1793007200000;
    // New order 3: Created 1 minute ago, stored in seconds (from an earlier change)
    const newSec = 1793010740;

    const insertOrderStmt = rawDb.prepare(`
      INSERT INTO orders (
        id, direction, status, user_counter_address, lock_id, terms_json, hash_lock,
        first_seen_at, created_at, updated_at
      ) VALUES (
        @id, 'BCH_TO_COUNTER', 'USER_LOCK_SEEN', @userCounterAddress, @lockId, @termsJson, @hashLock,
        @firstSeenAt, @createdAt, @updatedAt
      )
    `);

    insertOrderStmt.run({
      id: 'order-old-3h',
      userCounterAddress: '0x1111111111111111111111111111111111111111',
      lockId: '0xlock1',
      termsJson,
      hashLock: '0x' + '11'.repeat(32),
      firstSeenAt: oldMs1,
      createdAt: oldMs1,
      updatedAt: oldMs1,
    });

    insertOrderStmt.run({
      id: 'order-old-1h',
      userCounterAddress: '0x2222222222222222222222222222222222222222',
      lockId: '0xlock2',
      termsJson,
      hashLock: '0x' + '22'.repeat(32),
      firstSeenAt: oldMs2,
      createdAt: oldMs2,
      updatedAt: oldMs2,
    });

    insertOrderStmt.run({
      id: 'order-new-1m',
      userCounterAddress: '0x3333333333333333333333333333333333333333',
      lockId: '0xlock3',
      termsJson,
      hashLock: '0x' + '33'.repeat(32),
      firstSeenAt: newSec,
      createdAt: newSec,
      updatedAt: newSec,
    });

    // Also insert a pay link with milliseconds
    rawDb
      .prepare(
        `
      INSERT INTO pay_links (
        id, kind, recipient_cashaddr, recipient_locking_bytecode, token, expires_at, status, created_at, updated_at
      ) VALUES (
        'link-ms-1', 'invoice', 'bchtest:qqqq', '0x76a91400', 'PUSD', 1793086400000, 'ACTIVE', 1793000000000, 1793000000000
      )
    `,
      )
      .run();

    // Also insert an action with milliseconds
    rawDb
      .prepare(
        `
      INSERT INTO actions (
        order_id, action, status, intent_payload, txid, created_at, updated_at
      ) VALUES (
        'order-old-3h', 'SOLVER_LOCK', 'BROADCAST', '{}', 'txid1', 1793000000000, 1793000100000
      )
    `,
      )
      .run();

    // 2. DEMONSTRATE THE BUG BEFORE MIGRATION:
    // Raw SQL ORDER BY created_at ASC puts new order (1.79e9) BEFORE old orders (1.79e12)
    const rowsBefore = rawDb
      .prepare('SELECT id, created_at FROM orders ORDER BY created_at ASC')
      .all() as Array<{ id: string; created_at: number }>;
    expect(rowsBefore[0]!.id).toBe('order-new-1m'); // BUG: Newest order sorts FIRST!
    expect(rowsBefore[1]!.id).toBe('order-old-3h');
    expect(rowsBefore[2]!.id).toBe('order-old-1h');

    // Raw SQL MIN(created_at) returns the 1-minute-old order instead of the 3-hour-old order
    const minBefore = rawDb
      .prepare('SELECT MIN(created_at) as oldest FROM orders')
      .get() as { oldest: number };
    expect(minBefore.oldest).toBe(newSec); // BUG: 1-minute order is returned as oldest

    expect(rawDb.pragma('user_version', { simple: true })).toBe(2);
    rawDb.close();

    // 3. RUN MIGRATION BY OPENING WITH SolverDatabase
    const solverDb = new SolverDatabase(dbPath);

    // Schema version must now be 3
    expect(solverDb.db.pragma('user_version', { simple: true })).toBe(3);

    // 4. VERIFY CORRECT ORDERING AFTER MIGRATION:
    // Oldest order (3h ago) must sort FIRST, then 1h ago, then 1m ago
    const rowsAfter = solverDb.db
      .prepare('SELECT id, created_at FROM orders ORDER BY created_at ASC')
      .all() as Array<{ id: string; created_at: number }>;
    expect(rowsAfter[0]!.id).toBe('order-old-3h');
    expect(rowsAfter[0]!.created_at).toBe(1793000000); // Converted to integer seconds

    expect(rowsAfter[1]!.id).toBe('order-old-1h');
    expect(rowsAfter[1]!.created_at).toBe(1793007200); // Converted to integer seconds

    expect(rowsAfter[2]!.id).toBe('order-new-1m');
    expect(rowsAfter[2]!.created_at).toBe(1793010740); // Preserved in seconds

    // Oldest order age calculation is now accurate:
    // Evaluated at now = 1793010800 (1 minute after new order, 3 hours after old order)
    const ageSeconds = solverDb.getOldestNonTerminalOrderAgeSeconds(1793010800);
    expect(ageSeconds).toBe(1793010800 - 1793000000); // Exactly 10800 seconds (3 hours)

    // Pay link timestamps must all be converted to seconds
    const payLinkRow = solverDb.db
      .prepare('SELECT * FROM pay_links WHERE id = ?')
      .get('link-ms-1') as Record<string, unknown>;
    expect(payLinkRow.created_at).toBe(1793000000);
    expect(payLinkRow.updated_at).toBe(1793000000);
    expect(payLinkRow.expires_at).toBe(1793086400);

    // Actions timestamps must all be converted to seconds
    const actionRow = solverDb.db
      .prepare('SELECT * FROM actions WHERE order_id = ?')
      .get('order-old-3h') as Record<string, unknown>;
    expect(actionRow.created_at).toBe(1793000000);
    expect(actionRow.updated_at).toBe(1793000100);

    // first_seen_at stays in MILLISECONDS (DSProof window arithmetic,)
    const orderRow = solverDb.db
      .prepare('SELECT first_seen_at FROM orders WHERE id = ?')
      .get('order-old-3h') as { first_seen_at: number };
    expect(orderRow.first_seen_at).toBe(1793000000000);

    // Domain getters return correct records in seconds
    const order = solverDb.getOrder('order-old-3h');
    expect(order?.createdAt).toBe(1793000000);
    expect(order?.updatedAt).toBe(1793000000);
    expect(order?.firstSeenAt).toBe(1793000000000);

    const payLink = solverDb.getPayLink('link-ms-1');
    expect(payLink?.createdAt).toBe(1793000000);
    expect(payLink?.expiresAt).toBe(1793086400);

    solverDb.close();
  });

  it('migrates the real human operator database backup and validates ordering, schema, and API output', async () => {
    const backupDir = '/tmp/ferry-db-backup';
    const backupDbPath = path.join(backupDir, 'solver.db');
    if (!fs.existsSync(backupDbPath)) {
      // If backup directory not present in current test environment, skip
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-real-mig-'));
    tmpDirs.push(tmpDir);
    const testDbPath = path.join(tmpDir, 'solver.db');

    // Copy backup database files safely
    fs.copyFileSync(backupDbPath, testDbPath);
    if (fs.existsSync(backupDbPath + '-wal')) {
      fs.copyFileSync(backupDbPath + '-wal', testDbPath + '-wal');
    }
    if (fs.existsSync(backupDbPath + '-shm')) {
      fs.copyFileSync(backupDbPath + '-shm', testDbPath + '-shm');
    }

    // Check version and ms timestamps before migration
    const rawDb = new DatabaseConstructor(testDbPath);
    expect(rawDb.pragma('user_version', { simple: true })).toBe(2);
    const msCountBefore = rawDb
      .prepare(
        'SELECT COUNT(*) as c FROM orders WHERE created_at > 100000000000',
      )
      .get() as { c: number };
    expect(msCountBefore.c).toBeGreaterThan(0);
    rawDb.close();

    // Open with SolverDatabase to run v3 migration
    const solverDb = new SolverDatabase(testDbPath);
    expect(solverDb.db.pragma('user_version', { simple: true })).toBe(3);

    // Verify no millisecond timestamps remain anywhere in orders, pay_links, or actions
    const msOrdersAfter = solverDb.db
      .prepare(
        'SELECT COUNT(*) as c FROM orders WHERE created_at > 100000000000 OR updated_at > 100000000000',
      )
      .get() as { c: number };
    expect(msOrdersAfter.c).toBe(0);

    const msFirstSeenAfter = solverDb.db
      .prepare(
        'SELECT COUNT(*) as c FROM orders WHERE first_seen_at IS NOT NULL AND first_seen_at > 100000000000',
      )
      .get() as { c: number };
    // first_seen_at is deliberately left in milliseconds
    expect(msFirstSeenAfter.c).toBeGreaterThan(0);

    const msPayLinksAfter = solverDb.db
      .prepare(
        'SELECT COUNT(*) as c FROM pay_links WHERE created_at > 100000000000 OR updated_at > 100000000000 OR (expires_at IS NOT NULL AND expires_at > 100000000000)',
      )
      .get() as { c: number };
    expect(msPayLinksAfter.c).toBe(0);

    const msActionsAfter = solverDb.db
      .prepare(
        'SELECT COUNT(*) as c FROM actions WHERE created_at > 100000000000 OR updated_at > 100000000000',
      )
      .get() as { c: number };
    expect(msActionsAfter.c).toBe(0);

    // Verify all order timestamps are valid Unix timestamps in seconds (~1.7e9 to 2.0e9)
    const bounds = solverDb.db
      .prepare(
        'SELECT MIN(created_at) as min_ca, MAX(created_at) as max_ca, MIN(updated_at) as min_ua, MAX(updated_at) as max_ua FROM orders',
      )
      .get() as {
      min_ca: number;
      max_ca: number;
      min_ua: number;
      max_ua: number;
    };
    expect(bounds.min_ca).toBeGreaterThan(1_700_000_000);
    expect(bounds.max_ca).toBeLessThan(2_000_000_000);
    expect(bounds.min_ua).toBeGreaterThan(1_700_000_000);
    expect(bounds.max_ua).toBeLessThan(2_000_000_000);

    // Test API output with the migrated database
    const fakeBchClient = {
      isConnected: () => true,
      getQuorumStatus: () => ({
        quorumTip: 300000,
        tips: [300000, 300000],
        isQuorumHealthy: true,
        ageSeconds: 15,
        lastConfirmedAt: Math.floor(Date.now() / 1000) - 15,
        livenessAgeSeconds: 15,
        isLivenessHealthy: true,
      }),
      broadcastTransaction: async () => 'txid',
      onTip: () => () => {},
      subscribeAddress: () => {},
      unsubscribeAddress: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvmAdapter = {
      signerAddress: '0x0000000000000000000000000000000000000001',
      getTipStatus: async () => ({ height: 100, ageSeconds: 10, stale: false }),
    } as unknown as EvmChainAdapter;

    const engine = {
      getHealth: () => ({
        bch: { ok: true, height: 300000, tipAgeSeconds: 15, stale: false },
        evm: { ok: true, height: 100, tipAgeSeconds: 10, stale: false },
        openOrdersCount: 0,
        unfundedQuotesCount: 0,
        exposure: { totalUsd: 0, capUsd: 10000, utilizationPercent: 0 },
        exposureCap: {
          openExposureUsdMicros: 0n,
          openExposureFormatted: '$0.00',
          capUsdMicros: 10000000000n,
          capUsdFormatted: '$10000.00',
          availableUsdMicros: 10000000000n,
        },
      }),
      getStats: () => ({
        asOf: Math.floor(Date.now() / 1000),
        openOrdersCount: 0,
        settled24hCount: 0,
        volume24hUsd: '0',
      }),
      getActiveLimits: () => ({
        minSwapUsd: 5,
        maxSwapUsd: 1000,
        maxExposureUsd: 10000,
      }),
      createQuote: async () => {
        throw new Error('Not needed');
      },
      listRecentSwaps: () => solverDb.getRecentSwaps(10),
      getOrder: (id: string) => solverDb.getOrder(id),
      getNeedsAttentionSummary: () => solverDb.getNeedsAttentionOrdersSummary(),
      getRateLimiter: () => ({
        getAddressBucketCount: () => 0,
        getIpBucketCount: () => 0,
        getMaxEntries: () => 1000,
      }),
    } as unknown as SolverEngine;

    const config = SolverConfigSchema.parse({
      solverEvmPrivateKey:
        '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      solverBchWif: 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9',
      baseHtlcAddress: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      baseUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      operatorToken: '0123456789abcdef0123456789abcdef',
    });

    const app = buildServer({
      config,
      db: solverDb,
      bchClient: fakeBchClient,
      evmAdapter: fakeEvmAdapter,
      engine,
    });
    await app.ready();

    // Sample an existing migrated order from the database
    const sampleOrderRow = solverDb.db
      .prepare('SELECT id FROM orders LIMIT 1')
      .get() as { id: string };
    const orderRes = await app.inject({
      method: 'GET',
      url: `/v1/orders/${sampleOrderRow.id}`,
    });
    expect(orderRes.statusCode).toBe(200);
    const parsedOrder = OrderStatusResponseSchema.parse(
      JSON.parse(orderRes.body),
    );
    expect(parsedOrder.updatedAt).toBeGreaterThan(1_700_000_000);
    expect(parsedOrder.updatedAt).toBeLessThan(100_000_000_000); // In seconds, not ms

    // Recent orders check
    const recentRes = await app.inject({
      method: 'GET',
      url: '/v1/orders/recent',
    });
    expect(recentRes.statusCode).toBe(200);
    const parsedRecent = RecentSwapsResponseSchema.parse(
      JSON.parse(recentRes.body),
    );
    for (const swap of parsedRecent.swaps) {
      expect(swap.settledAt).toBeLessThan(100_000_000_000);
      expect(swap.durationSeconds).toBeGreaterThanOrEqual(0);
    }

    // Operator needs-attention check
    const attentionRes = await app.inject({
      method: 'GET',
      url: '/v1/operator/needs-attention',
      headers: {
        authorization: 'Bearer 0123456789abcdef0123456789abcdef',
      },
    });
    expect(attentionRes.statusCode).toBe(200);
    const parsedAttention = JSON.parse(attentionRes.body);
    expect(parsedAttention.timestamp).toBeLessThan(100_000_000_000);
    expect(parsedAttention.timestamp).toBeGreaterThan(1_700_000_000);
    for (const order of parsedAttention.orders) {
      expect(order.createdAt).toBeLessThan(100_000_000_000);
      expect(order.updatedAt).toBeLessThan(100_000_000_000);
      expect(order.ageSeconds).toBeGreaterThanOrEqual(0);
    }

    await app.close();
    solverDb.close();
  });
});
