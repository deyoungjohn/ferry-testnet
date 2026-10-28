import { describe, it, expect } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SolverDatabase } from '../src/db/database.js';

describe('Database Schema Migration', () => {
  it('successfully upgrades an existing pre-an earlier change database missing pay_link_id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-db-mig-'));
    const dbPath = path.join(tmpDir, 'legacy.db');

    // 1. Manually synthesize the exact pre-an earlier change database schema (user_version = 0, no pay_link_id)
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
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_counter_address, hash_lock)
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
      CREATE UNIQUE INDEX idx_orders_user_hashlock ON orders(user_counter_address, hash_lock);
    `);

    // Insert a legacy order
    const termsJson = JSON.stringify({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: '0x' + 'aa'.repeat(32),
      bchTokenAmount: '2485',
      counterAmount: '25000000',
      counterChain: 'base',
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      userCounterAddress: '0x1234567890123456789012345678901234567890',
      solverCounterAddress: '0x0987654321098765432109876543210987654321',
      counterDeadline: 1700000000,
      bchRefundHeight: 300000,
      userBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac',
      solverBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      bchCarrySats: '1000',
      fastOptIn: false,
    });

    rawDb
      .prepare(
        `
      INSERT INTO orders (
        id, direction, status, user_counter_address, lock_id, terms_json, hash_lock,
        created_at, updated_at
      ) VALUES (
        'order-legacy-1', 'COUNTER_TO_BCH', 'QUOTED', '0x1234567890123456789012345678901234567890',
        'lock-1', @termsJson, '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        1000, 1000
      )
    `,
      )
      .run({ termsJson });

    // Verify pre-migration state
    const colsBefore = rawDb.pragma('table_info(orders)') as Array<{
      name: string;
    }>;
    expect(colsBefore.some((c) => c.name === 'pay_link_id')).toBe(false);
    expect(rawDb.pragma('user_version', { simple: true })).toBe(0);
    rawDb.close();

    // 2. Open with SolverDatabase — must migrate smoothly without throwing "no such column: pay_link_id"
    const solverDb = new SolverDatabase(dbPath);

    // 3. Verify upgraded schema
    const colsAfter = solverDb.db.pragma('table_info(orders)') as Array<{
      name: string;
    }>;
    expect(colsAfter.some((c) => c.name === 'pay_link_id')).toBe(true);
    expect(solverDb.db.pragma('user_version', { simple: true })).toBe(3);

    // Verify index was created
    const indices = solverDb.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='orders'",
      )
      .all() as Array<{ name: string }>;
    expect(indices.some((i) => i.name === 'idx_orders_pay_link_id')).toBe(true);

    // Verify existing legacy order survived migration
    const order = solverDb.getOrder('order-legacy-1');
    expect(order).not.toBeNull();
    expect(order?.id).toBe('order-legacy-1');
    expect(order?.payLinkId).toBeUndefined();

    // Verify we can save and query payLinkId
    solverDb.saveOrder({
      ...order!,
      payLinkId: 'link-xyz-123',
    });
    const updatedOrder = solverDb.getOrder('order-legacy-1');
    expect(updatedOrder?.payLinkId).toBe('link-xyz-123');

    solverDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
