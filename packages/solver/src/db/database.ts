import DatabaseConstructor, {
  type Database as DatabaseType,
} from 'better-sqlite3';
import { convertCeil, evmLockId, type OrderTerms } from '@ferry/core';
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

export interface PayLinkRecord {
  id: string;
  kind: 'invoice' | 'open';
  recipientCashaddr: string;
  recipientLockingBytecode: string;
  token: 'PUSD' | 'MUSD';
  amountOut?: bigint | undefined;
  minAmountOut?: bigint | undefined;
  memo?: string | undefined;
  reference?: string | undefined;
  expiresAt?: number | undefined;
  verified: boolean;
  status: 'open' | 'reserved' | 'paid' | 'expired' | 'cancelled';
  orderId?: string | undefined;
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
    const tableExists = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'",
      )
      .get();

    if (!tableExists) {
      // Fresh database: create all tables with current schema
      this.db.exec(`
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
      `);
    } else {
      // Existing database: run schema migrations before creating any new indexes
      const columns = this.db.pragma('table_info(orders)') as Array<{
        name: string;
      }>;
      const colNames = new Set(columns.map((c) => c.name));

      // Migration v1 -> v2: pay_link_id column on orders
      if (!colNames.has('pay_link_id')) {
        this.db.exec('ALTER TABLE orders ADD COLUMN pay_link_id TEXT;');
      }
      if (!colNames.has('lane')) {
        this.db.exec("ALTER TABLE orders ADD COLUMN lane TEXT DEFAULT 'safe';");
      }
      if (!colNames.has('fast_opt_in')) {
        this.db.exec(
          'ALTER TABLE orders ADD COLUMN fast_opt_in INTEGER DEFAULT 0;',
        );
      }
      if (!colNames.has('first_seen_at')) {
        this.db.exec('ALTER TABLE orders ADD COLUMN first_seen_at INTEGER;');
      }
      if (!colNames.has('needs_attention')) {
        this.db.exec(
          'ALTER TABLE orders ADD COLUMN needs_attention INTEGER NOT NULL DEFAULT 0;',
        );
      }
      if (!colNames.has('rejection_reason')) {
        this.db.exec('ALTER TABLE orders ADD COLUMN rejection_reason TEXT;');
      }

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pay_links (
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
      `);
    }

    // Now all tables and columns are guaranteed to exist; create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_lock_id ON orders(lock_id);
      CREATE INDEX IF NOT EXISTS idx_orders_pay_link_id ON orders(pay_link_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_user_hashlock ON orders(user_counter_address, hash_lock);
      CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status);
      CREATE INDEX IF NOT EXISTS idx_pay_links_recipient ON pay_links(recipient_cashaddr);
      CREATE INDEX IF NOT EXISTS idx_pay_links_status ON pay_links(status);
      CREATE INDEX IF NOT EXISTS idx_pay_links_order_id ON pay_links(order_id);
    `);

    // Record schema user_version
    this.db.pragma('user_version = 2');
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
        solver_refund_txid, lane, fast_opt_in, first_seen_at, needs_attention, rejection_reason, pay_link_id, created_at, updated_at
      ) VALUES (
        @id, @direction, @status, @user_counter_address, @lock_id, @terms_json, @hash_lock, @secret, @secret_source,
        @user_lock_txid, @solver_lock_txid, @user_claim_txid, @solver_claim_txid,
        @solver_refund_txid, @lane, @fast_opt_in, @first_seen_at, @needs_attention, @rejection_reason, @pay_link_id, @created_at, @updated_at
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
        lane = excluded.lane,
        fast_opt_in = excluded.fast_opt_in,
        first_seen_at = COALESCE(excluded.first_seen_at, orders.first_seen_at),
        needs_attention = excluded.needs_attention,
        rejection_reason = excluded.rejection_reason,
        pay_link_id = COALESCE(excluded.pay_link_id, orders.pay_link_id),
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
      lane: order.lane ?? 'safe',
      fast_opt_in: order.fastOptIn ? 1 : 0,
      first_seen_at: order.firstSeenAt ?? null,
      needs_attention: order.needsAttention ? 1 : 0,
      rejection_reason: order.rejectionReason ?? null,
      pay_link_id: order.payLinkId ?? null,
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

  getOpenExposureUsdMicros(): bigint {
    const orders = this.listNonTerminalOrders();
    let totalMicros = 0n;
    for (const order of orders) {
      // Unfunded QUOTED orders do not count toward exposure until user lock is seen
      if (order.status === 'QUOTED') {
        continue;
      }
      const decimals = order.terms.counterAsset?.decimals ?? 6;
      totalMicros += convertCeil(order.terms.counterAmount, decimals, 6);
    }
    return totalMicros;
  }

  countUnfundedQuotesByAddress(userAddress: string): number {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      SELECT terms_json FROM orders
      WHERE LOWER(user_counter_address) = LOWER(?)
        AND status = 'QUOTED'
    `);
    const rows = stmt.all(userAddress) as Array<{ terms_json: string }>;
    let count = 0;
    for (const row of rows) {
      try {
        const terms = JSON.parse(row.terms_json);
        if (typeof terms.quoteExpiry === 'number' && terms.quoteExpiry > now) {
          count++;
        }
      } catch {
        // ignore malformed terms
      }
    }
    return count;
  }

  countGlobalUnfundedQuotes(): number {
    const now = Math.floor(Date.now() / 1000);
    const stmt = this.db.prepare(`
      SELECT terms_json FROM orders
      WHERE status = 'QUOTED'
    `);
    const rows = stmt.all() as Array<{ terms_json: string }>;
    let count = 0;
    for (const row of rows) {
      try {
        const terms = JSON.parse(row.terms_json);
        if (typeof terms.quoteExpiry === 'number' && terms.quoteExpiry > now) {
          count++;
        }
      } catch {
        // ignore malformed terms
      }
    }
    return count;
  }

  listNeedsAttentionOrders(): SolverOrderRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM orders WHERE needs_attention = 1 ORDER BY updated_at DESC
    `);
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((r) => this.mapOrderRow(r));
  }

  getOrderCountsByStatus(): Record<ForwardOrderStatus, number> {
    const counts: Record<ForwardOrderStatus, number> = {
      QUOTED: 0,
      USER_LOCK_SEEN: 0,
      USER_LOCK_FINAL: 0,
      SOLVER_LOCK_BROADCAST: 0,
      SOLVER_LOCK_SEEN: 0,
      SECRET_KNOWN: 0,
      USER_CLAIM_SEEN: 0,
      SOLVER_CLAIM_BROADCAST: 0,
      SOLVER_CLAIM_FINAL: 0,
      DONE: 0,
      EXPIRED: 0,
      REJECTED: 0,
      SOLVER_REFUNDED: 0,
    };

    const stmt = this.db.prepare(`
      SELECT status, COUNT(*) as count FROM orders GROUP BY status
    `);
    const rows = stmt.all() as Array<{ status: string; count: number }>;
    for (const r of rows) {
      if (r.status in counts) {
        counts[r.status as ForwardOrderStatus] = r.count;
      }
    }
    return counts;
  }

  getOldestNonTerminalOrderAgeSeconds(
    nowMs: number = Date.now(),
  ): number | null {
    const stmt = this.db.prepare(`
      SELECT MIN(created_at) as oldest_created_at
      FROM orders
      WHERE status NOT IN ('DONE', 'EXPIRED', 'REJECTED', 'SOLVER_REFUNDED')
    `);
    const row = stmt.get() as { oldest_created_at: number | null } | undefined;
    if (
      !row ||
      row.oldest_created_at === null ||
      row.oldest_created_at === undefined
    ) {
      return null;
    }
    return Math.max(0, Math.floor((nowMs - row.oldest_created_at) / 1000));
  }

  countNeedsAttentionOrders(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM orders WHERE needs_attention = 1')
      .get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  getNeedsAttentionOrdersSummary(nowMs: number = Date.now()): Array<{
    orderId: string;
    direction: 'BCH_TO_COUNTER' | 'COUNTER_TO_BCH';
    status: ForwardOrderStatus;
    lane?: 'safe' | 'fast' | undefined;
    createdAt: number;
    updatedAt: number;
    ageSeconds: number;
    rejectionReason?: string | undefined;
    terms: {
      counterAsset: { symbol: string; decimals: number };
      counterAmount: bigint;
      bchToken: 'PUSD' | 'MUSD';
      bchTokenAmount: bigint;
      userCounterAddress: string;
      userBchLockingBytecode: string;
      hashLock: `0x${string}`;
    };
    txIds: {
      userLockTxId?: string | undefined;
      solverLockTxId?: string | undefined;
      userClaimTxId?: string | undefined;
      solverClaimTxId?: string | undefined;
      solverRefundTxId?: string | undefined;
    };
  }> {
    const orders = this.listNeedsAttentionOrders();
    return orders.map((order) => {
      // STRICT PRIVACY: secret is NEVER included in operator listing
      return {
        orderId: order.id,
        direction: order.direction,
        status: order.status,
        lane: order.lane,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        ageSeconds: Math.max(0, Math.floor((nowMs - order.createdAt) / 1000)),
        rejectionReason: order.rejectionReason,
        terms: {
          counterAsset: {
            symbol: order.terms.counterAsset.symbol,
            decimals: order.terms.counterAsset.decimals,
          },
          counterAmount: order.terms.counterAmount,
          bchToken: order.terms.bchToken,
          bchTokenAmount: order.terms.bchTokenAmount,
          userCounterAddress: order.terms.userCounterAddress,
          userBchLockingBytecode: order.terms.userBchLockingBytecode,
          hashLock: order.terms.hashLock,
        },
        txIds: {
          userLockTxId: order.userLockTxId,
          solverLockTxId: order.solverLockTxId,
          userClaimTxId: order.userClaimTxId,
          solverClaimTxId: order.solverClaimTxId,
          solverRefundTxId: order.solverRefundTxId,
        },
      };
    });
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
      lane: (row.lane as 'safe' | 'fast') || 'safe',
      fastOptIn: row.fast_opt_in === 1,
      firstSeenAt: (row.first_seen_at as number) || undefined,
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
      payLinkId: (row.pay_link_id as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  savePayLink(link: PayLinkRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO pay_links (
        id, kind, recipient_cashaddr, recipient_locking_bytecode, token,
        amount_out, min_amount_out, memo, reference, expires_at,
        verified, status, order_id, created_at, updated_at
      ) VALUES (
        @id, @kind, @recipient_cashaddr, @recipient_locking_bytecode, @token,
        @amount_out, @min_amount_out, @memo, @reference, @expires_at,
        @verified, @status, @order_id, @created_at, @updated_at
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        recipient_cashaddr = excluded.recipient_cashaddr,
        recipient_locking_bytecode = excluded.recipient_locking_bytecode,
        token = excluded.token,
        amount_out = excluded.amount_out,
        min_amount_out = excluded.min_amount_out,
        memo = excluded.memo,
        reference = excluded.reference,
        expires_at = excluded.expires_at,
        verified = excluded.verified,
        status = excluded.status,
        order_id = excluded.order_id,
        updated_at = excluded.updated_at
    `);

    stmt.run({
      id: link.id,
      kind: link.kind,
      recipient_cashaddr: link.recipientCashaddr,
      recipient_locking_bytecode: link.recipientLockingBytecode.toLowerCase(),
      token: link.token,
      amount_out:
        link.amountOut !== undefined ? link.amountOut.toString(10) : null,
      min_amount_out:
        link.minAmountOut !== undefined ? link.minAmountOut.toString(10) : null,
      memo: link.memo ?? null,
      reference: link.reference ?? null,
      expires_at: link.expiresAt ?? null,
      verified: link.verified ? 1 : 0,
      status: link.status,
      order_id: link.orderId ?? null,
      created_at: link.createdAt,
      updated_at: link.updatedAt,
    });
  }

  getPayLink(id: string): PayLinkRecord | null {
    const stmt = this.db.prepare('SELECT * FROM pay_links WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const link = this.mapPayLinkRow(row);
    const now = Math.floor(Date.now() / 1000);
    if (
      link.expiresAt !== undefined &&
      link.expiresAt <= now &&
      (link.status === 'open' || link.status === 'reserved')
    ) {
      this.updatePayLinkStatus(link.id, 'expired');
      link.status = 'expired';
    }
    return link;
  }

  getPayLinkByOrderId(orderId: string): PayLinkRecord | null {
    const stmt = this.db.prepare(
      'SELECT * FROM pay_links WHERE order_id = ? LIMIT 1',
    );
    const row = stmt.get(orderId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapPayLinkRow(row);
  }

  listPayLinksByRecipient(recipientCashaddr: string): PayLinkRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM pay_links WHERE recipient_cashaddr = ? ORDER BY created_at DESC',
    );
    const rows = stmt.all(recipientCashaddr) as Record<string, unknown>[];
    const now = Math.floor(Date.now() / 1000);
    return rows.map((row) => {
      const link = this.mapPayLinkRow(row);
      if (
        link.expiresAt !== undefined &&
        link.expiresAt <= now &&
        (link.status === 'open' || link.status === 'reserved')
      ) {
        this.updatePayLinkStatus(link.id, 'expired');
        link.status = 'expired';
      }
      return link;
    });
  }

  updatePayLinkStatus(
    id: string,
    status: PayLinkRecord['status'],
    orderId?: string | null,
  ): void {
    const now = Math.floor(Date.now() / 1000);
    if (orderId !== undefined) {
      const stmt = this.db.prepare(`
        UPDATE pay_links
        SET status = ?, order_id = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(status, orderId, now, id);
    } else {
      const stmt = this.db.prepare(`
        UPDATE pay_links
        SET status = ?, updated_at = ?
        WHERE id = ?
      `);
      stmt.run(status, now, id);
    }
  }

  private mapPayLinkRow(row: Record<string, unknown>): PayLinkRecord {
    return {
      id: row.id as string,
      kind: row.kind as 'invoice' | 'open',
      recipientCashaddr: row.recipient_cashaddr as string,
      recipientLockingBytecode: row.recipient_locking_bytecode as string,
      token: row.token as 'PUSD' | 'MUSD',
      amountOut:
        row.amount_out !== null && row.amount_out !== undefined
          ? BigInt(row.amount_out as string)
          : undefined,
      minAmountOut:
        row.min_amount_out !== null && row.min_amount_out !== undefined
          ? BigInt(row.min_amount_out as string)
          : undefined,
      memo: (row.memo as string) || undefined,
      reference: (row.reference as string) || undefined,
      expiresAt: (row.expires_at as number) || undefined,
      verified: row.verified === 1,
      status: row.status as PayLinkRecord['status'],
      orderId: (row.order_id as string) || undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  getStatsSummary(
    spreadBps: number,
    fixedFeeUsdMicros: bigint,
  ): {
    completedSwaps: number | null;
    volumeUsdMicros: bigint | null;
    medianFastSeconds: number | null;
    quotePolicy: { spreadBps: number; fixedFeeUsdMicros: bigint } | null;
    asOf: number | null;
  } {
    const stmt = this.db.prepare(`
      SELECT terms_json, lane, created_at, updated_at
      FROM orders
      WHERE status = 'DONE'
    `);
    const rows = stmt.all() as {
      terms_json: string;
      lane: string;
      created_at: number;
      updated_at: number;
    }[];

    if (rows.length === 0) {
      return {
        completedSwaps: null,
        volumeUsdMicros: null,
        medianFastSeconds: null,
        quotePolicy: {
          spreadBps,
          fixedFeeUsdMicros,
        },
        asOf: null,
      };
    }

    let volumeUsdMicros = 0n;
    const fastDurations: number[] = [];

    for (const row of rows) {
      try {
        const terms = JSON.parse(row.terms_json);
        if (terms && terms.counterAmount) {
          volumeUsdMicros += BigInt(terms.counterAmount);
        }
      } catch {
        // Skip malformed row
      }

      if (row.lane === 'fast') {
        const duration = Math.max(
          0,
          Math.floor((row.updated_at - row.created_at) / 1000),
        );
        fastDurations.push(duration);
      }
    }

    let medianFastSeconds: number | null = null;
    if (fastDurations.length > 0) {
      fastDurations.sort((a, b) => a - b);
      const mid = Math.floor(fastDurations.length / 2);
      const midVal = fastDurations[mid];
      if (midVal !== undefined) {
        if (fastDurations.length % 2 !== 0) {
          medianFastSeconds = midVal;
        } else {
          const prevVal = fastDurations[mid - 1];
          medianFastSeconds =
            prevVal !== undefined ? Math.floor((prevVal + midVal) / 2) : midVal;
        }
      }
    }

    return {
      completedSwaps: rows.length,
      volumeUsdMicros,
      medianFastSeconds,
      quotePolicy: {
        spreadBps,
        fixedFeeUsdMicros,
      },
      asOf: Math.floor(Date.now() / 1000),
    };
  }

  getRecentSwaps(limit: number = 50): Array<{
    orderId: `0x${string}`;
    settledAt: number;
    direction: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
    counterSymbol: string;
    counterDecimals: number;
    counterAmount: bigint;
    bchSymbol: string;
    bchDecimals: number;
    bchTokenAmount: bigint;
    durationSeconds: number;
    baseTxId: `0x${string}`;
    bchTxId: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT * FROM orders
      WHERE status = 'DONE'
      ORDER BY updated_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as Record<string, unknown>[];
    const result: Array<{
      orderId: `0x${string}`;
      settledAt: number;
      direction: 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
      counterSymbol: string;
      counterDecimals: number;
      counterAmount: bigint;
      bchSymbol: string;
      bchDecimals: number;
      bchTokenAmount: bigint;
      durationSeconds: number;
      baseTxId: `0x${string}`;
      bchTxId: string;
    }> = [];

    for (const r of rows) {
      const order = this.mapOrderRow(r);
      const isReverse = order.direction === 'BCH_TO_COUNTER';

      const rawBaseTxId = isReverse
        ? order.solverLockTxId || order.userClaimTxId
        : order.userLockTxId || order.solverClaimTxId;
      const rawBchTxId = isReverse
        ? order.userLockTxId || order.solverClaimTxId
        : order.solverLockTxId || order.userClaimTxId;

      if (!rawBaseTxId || !rawBchTxId) continue;

      const baseTxId = this.formatHex32(rawBaseTxId);
      const bchTxId = this.formatBchTxId(rawBchTxId);
      if (!baseTxId || !bchTxId) continue;

      const durationSeconds = Math.max(
        0,
        Math.floor((order.updatedAt - order.createdAt) / 1000),
      );

      result.push({
        orderId: order.id as `0x${string}`,
        settledAt: Math.floor(order.updatedAt / 1000),
        direction: order.direction,
        counterSymbol: order.terms.counterAsset.symbol,
        counterDecimals: order.terms.counterAsset.decimals,
        counterAmount: order.terms.counterAmount,
        bchSymbol: order.terms.bchToken,
        bchDecimals: 2,
        bchTokenAmount: order.terms.bchTokenAmount,
        durationSeconds,
        baseTxId,
        bchTxId,
      });
    }

    return result;
  }

  private formatHex32(txId: string): `0x${string}` | null {
    const clean = txId.trim();
    const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return `0x${hex.toLowerCase()}` as `0x${string}`;
    }
    return null;
  }

  private formatBchTxId(txId: string): string | null {
    const clean = txId.trim();
    const hex = clean.startsWith('0x') ? clean.slice(2) : clean;
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      return hex.toLowerCase();
    }
    return null;
  }

  close(): void {
    this.db.close();
  }
}
