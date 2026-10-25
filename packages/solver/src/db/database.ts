import DatabaseConstructor, {
  type Database as DatabaseType,
} from 'better-sqlite3';
import { evmLockId, type OrderTerms } from '@ferry/core';
import type {
  SolverOrderRecord,
  ForwardOrderStatus,
  SecretSource,
} from '../state-machine/types.js';

export interface ActionRecord {
  orderId: string;
  action: string;
  status: 'PENDING' | 'BROADCAST' | 'CONFIRMED' | 'FAILED';
  intentPayload: string;
  txId?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export class SolverDatabase {
  public readonly db: DatabaseType;

  constructor(dbPath: string = ':memory:') {
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.initTables();
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
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
        needs_attention INTEGER NOT NULL DEFAULT 0,
        rejection_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (user_counter_address, hash_lock)
      );

      CREATE TABLE IF NOT EXISTS actions (
        order_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        intent_payload TEXT NOT NULL,
        txid TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (order_id, action)
      );

      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_lock_id ON orders(lock_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_hashlock ON orders(user_counter_address, hash_lock);
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
    `);
  }

  saveOrder(order: SolverOrderRecord): void {
    const lockerAddress =
      order.direction === 'BCH_TO_COUNTER'
        ? order.terms.solverCounterAddress
        : order.terms.userCounterAddress;
    const lockId = evmLockId(lockerAddress, order.hashLock).toLowerCase();

    const stmt = this.db.prepare(`
      INSERT INTO orders (
        id, direction, status, user_counter_address, lock_id, terms_json, hash_lock, secret, secret_source,
        user_lock_txid, solver_lock_txid, user_claim_txid, solver_claim_txid,
        solver_refund_txid, needs_attention, rejection_reason, created_at, updated_at
      ) VALUES (
        @id, @direction, @status, @user_counter_address, @lock_id, @terms_json, @hash_lock, @secret, @secret_source,
        @user_lock_txid, @solver_lock_txid, @user_claim_txid, @solver_claim_txid,
        @solver_refund_txid, @needs_attention, @rejection_reason, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        secret = excluded.secret,
        secret_source = excluded.secret_source,
        user_lock_txid = excluded.user_lock_txid,
        solver_lock_txid = excluded.solver_lock_txid,
        user_claim_txid = excluded.user_claim_txid,
        solver_claim_txid = excluded.solver_claim_txid,
        solver_refund_txid = excluded.solver_refund_txid,
        needs_attention = excluded.needs_attention,
        rejection_reason = excluded.rejection_reason,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      id: order.id,
      direction: order.direction,
      status: order.status,
      user_counter_address: order.terms.userCounterAddress.toLowerCase(),
      lock_id: lockId,
      terms_json: JSON.stringify(order.terms, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
      hash_lock: order.hashLock.toLowerCase(),
      secret: order.secret ?? null,
      secret_source: order.secretSource ?? null,
      user_lock_txid: order.userLockTxId ?? null,
      solver_lock_txid: order.solverLockTxId ?? null,
      user_claim_txid: order.userClaimTxId ?? null,
      solver_claim_txid: order.solverClaimTxId ?? null,
      solver_refund_txid: order.solverRefundTxId ?? null,
      needs_attention: order.needsAttention ? 1 : 0,
      rejection_reason: order.rejectionReason ?? null,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    });
  }

  getOrder(id: string): SolverOrderRecord | null {
    const stmt = this.db.prepare('SELECT * FROM orders WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapOrderRow(row);
  }

  getOrderByLockId(lockId: string): SolverOrderRecord | null {
    const cleanId = lockId.toLowerCase();
    const stmt = this.db.prepare(
      'SELECT * FROM orders WHERE lower(lock_id) = lower(?) LIMIT 1',
    );
    const row = stmt.get(cleanId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapOrderRow(row);
  }

  getOrderByUserAndHashLock(
    userCounterAddress: string,
    hashLock: string,
  ): SolverOrderRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM orders WHERE lower(user_counter_address) = lower(?) AND lower(hash_lock) = lower(?) LIMIT 1',
    );
    const row = stmt.get(
      userCounterAddress.toLowerCase(),
      hashLock.toLowerCase(),
    ) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapOrderRow(row);
  }

  markNeedsAttention(orderId: string, reason?: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE orders
      SET needs_attention = 1,
          rejection_reason = COALESCE(rejection_reason, ?),
          updated_at = ?
      WHERE id = ?
    `);
    stmt.run(reason ?? null, now, orderId);
  }

  listNonTerminalOrders(): SolverOrderRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM orders
      WHERE status NOT IN ('DONE', 'EXPIRED', 'REJECTED', 'SOLVER_REFUNDED')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapOrderRow(r));
  }

  listNeedsAttentionOrders(): SolverOrderRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM orders WHERE needs_attention = 1 ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapOrderRow(r));
  }

  recordActionIntent(
    orderId: string,
    action: string,
    intentPayload: unknown,
  ): void {
    const now = Date.now();
    const payloadStr =
      typeof intentPayload === 'string'
        ? intentPayload
        : JSON.stringify(intentPayload, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v,
          );

    const stmt = this.db.prepare(`
      INSERT INTO actions (order_id, action, status, intent_payload, txid, created_at, updated_at)
      VALUES (?, ?, 'PENDING', ?, NULL, ?, ?)
      ON CONFLICT(order_id, action) DO UPDATE SET
        intent_payload = excluded.intent_payload,
        updated_at = excluded.updated_at
    `);
    stmt.run(orderId, action, payloadStr, now, now);
  }

  recordActionBroadcast(orderId: string, action: string, txId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE actions
      SET status = 'BROADCAST', txid = ?, updated_at = ?
      WHERE order_id = ? AND action = ?
    `);
    stmt.run(txId, now, orderId, action);
  }

  recordActionConfirmed(orderId: string, action: string, txId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE actions
      SET status = 'CONFIRMED', txid = ?, updated_at = ?
      WHERE order_id = ? AND action = ?
    `);
    stmt.run(txId, now, orderId, action);
  }

  recordActionFailed(orderId: string, action: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      UPDATE actions
      SET status = 'FAILED', updated_at = ?
      WHERE order_id = ? AND action = ?
    `);
    stmt.run(now, orderId, action);
  }

  getAction(orderId: string, action: string): ActionRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM actions WHERE order_id = ? AND action = ?',
    );
    const row = stmt.get(orderId, action) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      orderId: row.order_id as string,
      action: row.action as string,
      status: row.status as ActionRecord['status'],
      intentPayload: row.intent_payload as string,
      txId: (row.txid as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  private mapOrderRow(row: Record<string, unknown>): SolverOrderRecord {
    const parsedTerms = JSON.parse(row.terms_json as string, (key, value) => {
      if (
        key === 'bchTokenAmount' ||
        key === 'counterAmount' ||
        key === 'bchCarrySats' ||
        key === 'bchMaxFee'
      ) {
        return BigInt(value);
      }
      return value;
    }) as OrderTerms;

    return {
      id: row.id as string,
      direction: row.direction as 'BCH_TO_COUNTER' | 'COUNTER_TO_BCH',
      status: row.status as ForwardOrderStatus,
      terms: parsedTerms,
      hashLock: row.hash_lock as `0x${string}`,
      secret: (row.secret as `0x${string}`) || undefined,
      secretSource: (row.secret_source as SecretSource) || undefined,
      userLockTxId: (row.user_lock_txid as string) || undefined,
      solverLockTxId: (row.solver_lock_txid as string) || undefined,
      userClaimTxId: (row.user_claim_txid as string) || undefined,
      solverClaimTxId: (row.solver_claim_txid as string) || undefined,
      solverRefundTxId: (row.solver_refund_txid as string) || undefined,
      needsAttention: row.needs_attention === 1,
      rejectionReason: (row.rejection_reason as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  close(): void {
    this.db.close();
  }
}
