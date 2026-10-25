import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { evmLockId, parseOrderTerms } from '@ferry/core';
import { SolverDatabase } from '../src/db/database.js';

describe('Order lookup and uniqueness constraint on (userCounterAddress, hashLock)', () => {
  let db: SolverDatabase;
  let tempDbPath: string;

  beforeEach(() => {
    tempDbPath = path.join(
      process.cwd(),
      `test-db-uniq-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new SolverDatabase(tempDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  });

  const getDummyTerms = (userCounterAddress: string, hashLock: `0x${string}`) =>
    parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'aa'.repeat(32)}`,
      bchTokenAmount: 2485n,
      counterAmount: 25000000n,
      counterChain: 'base',
      counterNetworkId: 31337,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      userCounterAddress,
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      solverBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      hashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: `quote-${userCounterAddress}`,
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
    });

  it('allows two different users to share the same hashLock without collision', () => {
    const sharedHashLock = `0x${'ee'.repeat(32)}` as const;
    const userA = '0x1111111111111111111111111111111111111111';
    const userB = '0x2222222222222222222222222222222222222222';

    const termsA = getDummyTerms(userA, sharedHashLock);
    const termsB = getDummyTerms(userB, sharedHashLock);

    const orderA = {
      id: '0xorder-user-a',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      terms: termsA,
      hashLock: sharedHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const orderB = {
      id: '0xorder-user-b',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      terms: termsB,
      hashLock: sharedHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Both orders can be saved simultaneously
    db.saveOrder(orderA);
    db.saveOrder(orderB);

    // Lock ID lookup resolves to the distinct matching orders
    const lockIdA = evmLockId(userA, sharedHashLock);
    const lockIdB = evmLockId(userB, sharedHashLock);
    expect(lockIdA).not.toBe(lockIdB);

    const foundA = db.getOrderByLockId(lockIdA);
    const foundB = db.getOrderByLockId(lockIdB);

    expect(foundA?.id).toBe('0xorder-user-a');
    expect(foundB?.id).toBe('0xorder-user-b');

    // Querying by (user, hashLock) also resolves cleanly
    expect(db.getOrderByUserAndHashLock(userA, sharedHashLock)?.id).toBe(
      '0xorder-user-a',
    );
    expect(db.getOrderByUserAndHashLock(userB, sharedHashLock)?.id).toBe(
      '0xorder-user-b',
    );
  });

  it('enforces SQLite uniqueness constraint on (userCounterAddress, hashLock)', () => {
    const sharedHashLock = `0x${'ff'.repeat(32)}` as const;
    const userA = '0x3333333333333333333333333333333333333333';

    const terms1 = getDummyTerms(userA, sharedHashLock);
    const terms2 = getDummyTerms(userA, sharedHashLock);

    const order1 = {
      id: '0xorder-first',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      terms: terms1,
      hashLock: sharedHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const order2 = {
      id: '0xorder-second-conflicting',
      direction: 'COUNTER_TO_BCH' as const,
      status: 'QUOTED' as const,
      terms: terms2,
      hashLock: sharedHashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    db.saveOrder(order1);

    // Saving a second order for the same (user, hashLock) must throw constraint violation
    expect(() => db.saveOrder(order2)).toThrow(/UNIQUE constraint failed/);
  });
});
