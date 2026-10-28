import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from 'viem';
import { orderId as computeOrderId, parseOrderTerms } from '@ferry/core';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import type { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';

/**
 *: the runner's age arithmetic must agree with the units the
 * database stores (actions.updated_at in seconds, orders.first_seen_at in ms).
 */
describe('timestamp unit consumers in the runner', () => {
  const dbPaths: string[] = [];
  afterEach(() => {
    for (const p of dbPaths.splice(0)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(p + suffix)) fs.unlinkSync(p + suffix);
      }
    }
  });

  function makeEngine(bch: Partial<BchQuorumClient>) {
    const dbPath = path.join(
      process.cwd(),
      `test-units-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    dbPaths.push(dbPath);
    const db = new SolverDatabase(dbPath);
    const engine = new SolverEngine(
      db,
      {} as EvmChainAdapter,
      bch as BchQuorumClient,
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
      'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9',
      'testnet',
    );
    return { db, engine };
  }

  function seedOrder(db: SolverDatabase) {
    const secret =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const hashLock = sha256(secret as `0x${string}`);
    const terms = parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'bb'.repeat(32)}`,
      bchTokenAmount: 100n,
      counterAmount: 1000000n,
      counterChain: 'base',
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      solverBchLockingBytecode:
        '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac',
      hashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330000,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-units-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
    });
    const id = computeOrderId(terms);
    const now = Math.floor(Date.now() / 1000);
    db.saveOrder({
      id,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_CLAIM_SEEN',
      terms,
      hashLock,
      secret: secret as `0x${string}`,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  it('a just-broadcast action is not stale: it is rebroadcast, never rebuilt', async () => {
    const bch = {
      broadcast: vi.fn().mockResolvedValue('ok'),
      getHistory: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockRejectedValue(new Error('not seen yet')),
      listUnspent: vi.fn().mockResolvedValue([]),
    };
    const { db, engine } = makeEngine(bch);
    const id = seedOrder(db);
    db.recordActionIntent(id, 'SOLVER_CLAIM', {
      txid: 'justsent',
      txHex: '0200',
    });
    db.recordActionBroadcast(id, 'SOLVER_CLAIM', 'justsent');

    const build = vi.fn().mockResolvedValue({ txid: 'rebuilt', txHex: '0201' });
    const result = await engine.executeOrAdoptBchTx({
      orderId: id,
      actionType: 'SOLVER_CLAIM',
      buildTx: build,
      verifyTx: () => true,
      isOnChain: async () => false,
    });

    expect(build).not.toHaveBeenCalled();
    expect(result.txid).toBe('justsent');
    db.close();
  });

  it('an action older than the claim timeout and absent from the network is rebuilt', async () => {
    const bch = {
      broadcast: vi.fn().mockResolvedValue('ok'),
      getHistory: vi.fn().mockResolvedValue([]),
      getTransaction: vi.fn().mockRejectedValue(new Error('not found')),
      listUnspent: vi.fn().mockResolvedValue([]),
    };
    const { db, engine } = makeEngine(bch);
    const id = seedOrder(db);
    db.recordActionIntent(id, 'SOLVER_CLAIM', {
      txid: 'dropped',
      txHex: '0200',
    });
    db.recordActionBroadcast(id, 'SOLVER_CLAIM', 'dropped');
    db.db
      .prepare('UPDATE actions SET updated_at = ? WHERE order_id = ?')
      .run(Math.floor(Date.now() / 1000) - 10 * 60, id);

    const build = vi.fn().mockResolvedValue({ txid: 'rebuilt', txHex: '0201' });
    const result = await engine.executeOrAdoptBchTx({
      orderId: id,
      actionType: 'SOLVER_CLAIM',
      buildTx: build,
      verifyTx: () => true,
      isOnChain: async () => false,
    });

    expect(build).toHaveBeenCalledTimes(1);
    expect(result.txid).toBe('rebuilt');
    db.close();
  });

  it('first_seen_at keeps millisecond precision through save and load', () => {
    const { db } = makeEngine({});
    const id = seedOrder(db);
    const order = db.getOrder(id)!;
    order.firstSeenAt = 1_793_000_000_123;
    db.saveOrder(order);
    expect(db.getOrder(id)?.firstSeenAt).toBe(1_793_000_000_123);
    db.close();
  });
});
