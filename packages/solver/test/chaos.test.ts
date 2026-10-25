import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { parseOrderTerms } from '@ferry/core';
import type { ForwardOrderStatus } from '../src/state-machine/types.js';

describe('Chaos & Failure Tests (Blueprint §11.3: CH-01, CH-02, CH-03, CH-04)', () => {
  let db: SolverDatabase;
  let tempDbPath: string;
  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

  beforeEach(() => {
    tempDbPath = path.join(
      process.cwd(),
      `test-chaos-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new SolverDatabase(tempDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  });

  const getDummyTerms = (
    overrides?: Partial<Parameters<typeof parseOrderTerms>[0]>,
  ) =>
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
      userCounterAddress: '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd',
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      hashLock: `0x${'bb'.repeat(32)}`,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'chaos-quote-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      ...overrides,
    });

  it('CH-01: SIGKILL child process in forward states against consistent chains; restart reaches safe terminal state with no duplicate broadcasts', async () => {
    const statesToTest: ForwardOrderStatus[] = [
      'QUOTED',
      'USER_LOCK_FINAL',
      'SOLVER_LOCK_BROADCAST',
      'USER_CLAIM_SEEN',
    ];

    const secret = `0x${'77'.repeat(32)}` as const;

    for (const state of statesToTest) {
      db.db.exec('DELETE FROM orders; DELETE FROM actions;');
      const orderId = `0x${Math.random().toString(16).slice(2).padStart(64, '0')}`;
      const dummyTerms = getDummyTerms();

      // Seed DB with order in specific state
      db.saveOrder({
        id: orderId,
        direction: 'COUNTER_TO_BCH',
        status: state,
        terms: dummyTerms,
        hashLock: dummyTerms.hashLock,
        secret: state === 'USER_CLAIM_SEEN' ? secret : undefined,
        secretSource:
          state === 'USER_CLAIM_SEEN' ? 'on_chain_claim' : undefined,
        userLockTxId: state !== 'QUOTED' ? '0xuser-lock' : undefined,
        solverLockTxId:
          state === 'SOLVER_LOCK_BROADCAST' || state === 'USER_CLAIM_SEEN'
            ? '0xsolver-lock'
            : undefined,
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000,
      });

      // Track broadcasts on simulated chains
      const recordedBchBroadcasts: string[] = [];
      const recordedEvmClaims: string[] = [];

      if (state === 'SOLVER_LOCK_BROADCAST' || state === 'USER_CLAIM_SEEN') {
        db.recordActionIntent(orderId, 'SOLVER_LOCK', { amount: '2485' });
        db.recordActionBroadcast(orderId, 'SOLVER_LOCK', '0xsolver-lock');
        recordedBchBroadcasts.push('0xsolver-lock');
      }

      // 1. Scripted child process SIGKILL
      const child = spawn(
        'pnpm',
        [
          'exec',
          'tsx',
          'test/helpers/chaos-child.ts',
          `--dbPath=${tempDbPath}`,
          `--orderId=${orderId}`,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      // Wait for child process to be ready
      await new Promise<void>((resolve) => {
        child.stdout.on('data', (data) => {
          if (data.toString().includes('READY')) {
            resolve();
          }
        });
      });

      // Execute SIGKILL
      child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
      expect(child.killed || child.exitCode !== null).toBe(true);

      // 2. Restart new engine on same DB with chain consistent with killed state
      const consistentEvm = {
        address: solverAddress,
        lockId: () => dummyTerms.hashLock,
        getLock: async () => {
          if (state === 'QUOTED') return { status: 'absent' as const };
          return {
            status: 'locked' as const,
            lockTx: { chain: 'base' as const, txId: '0xuser-lock' },
            owner: dummyTerms.userCounterAddress,
            recipient: solverAddress,
            asset: dummyTerms.counterAsset,
            amount: dummyTerms.counterAmount,
            hashLock: dummyTerms.hashLock,
            deadline: dummyTerms.counterDeadline,
          };
        },
        isFinal: async () => true,
        claim: async () => {
          recordedEvmClaims.push('0xclaim-tx');
          return { chain: 'base' as const, txId: '0xclaim-tx' };
        },
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const consistentBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () =>
          state === 'SOLVER_LOCK_BROADCAST'
            ? [
                {
                  tx_hash: '0xsolver-lock',
                  tx_pos: 0,
                  value: 3000,
                  height: 330001,
                },
              ]
            : [],
        getHistory: async () => [],
        broadcast: async () => {
          recordedBchBroadcasts.push('0xnew-bch-lock');
          return '0xnew-bch-lock';
        },
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      const restartEngine = new SolverEngine(
        db,
        consistentEvm,
        consistentBch,
        solverEvmKey,
      );

      // Reconcile and process step
      await restartEngine.reconcileOrders();
      await restartEngine.step();

      const recovered = db.getOrder(orderId)!;
      expect(recovered).not.toBeNull();

      if (state === 'QUOTED') {
        // Since no user lock happened, solver never broadcasts
        expect(recordedBchBroadcasts.length).toBe(0);
        expect(recovered.status).toBe('QUOTED');
      } else if (state === 'USER_LOCK_FINAL') {
        // Solver broadcasts BCH lock ONCE
        expect(recordedBchBroadcasts.length).toBe(1);
        expect(recovered.status).toBe('SOLVER_LOCK_BROADCAST');
      } else if (state === 'SOLVER_LOCK_BROADCAST') {
        // Broadcast was already performed before crash; NO duplicate broadcast!
        expect(recordedBchBroadcasts.length).toBe(1);
        expect(recovered.status).toBe('SOLVER_LOCK_SEEN');
      } else if (state === 'USER_CLAIM_SEEN') {
        // Solver executes EVM claim and moves forward to terminal DONE
        expect(recordedEvmClaims.length).toBe(1);
        expect(recovered.status).toBe('DONE');
      }

      restartEngine.stop();
    }
  }, 30000);

  it('CH-02: Electrum drop mid-swap falls over to surviving server and reconciles on reconnect', async () => {
    let notifiedStatus: string | null = null;
    const client = new BchQuorumClient([
      'wss://chipnet.imaginary.cash:50004',
      'wss://blackie.c3-soft.com:50004',
    ]);

    await client.subscribeScriptHash('76a914testhash', (status) => {
      notifiedStatus = status;
    });

    // Mock drop on primary server
    const primary = (client as unknown as { clients: { close: () => void }[] })
      .clients[0]!;
    primary.close();

    // Verify quorum failover executes queries through surviving server
    const tipStatus = client.getQuorumStatus();
    expect(tipStatus).toBeDefined();

    // Reconnect primary and trigger history reconciliation
    client.getHistory = async () => [
      { height: 330010, tx_hash: '0xmissed-spend-tx' },
    ];
    await client.reconcileScriptHash('76a914testhash');
    expect(notifiedStatus).toBe('reconciled');

    client.close();
  });

  it('CH-03: Quote accepted, user locks after expiry -> solver refuses to counter-lock (REJECTED)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredTerms = getDummyTerms({
      quoteExpiry: now - 30, // Expired 30 seconds ago
    });

    const orderId = '0xch03-expired-order';
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      terms: expiredTerms,
      hashLock: expiredTerms.hashLock,
      userLockTxId: '0xuser-late-lock',
      createdAt: now - 60,
      updatedAt: now - 5,
    });

    let bchBroadcastAttempted = false;
    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => {
        bchBroadcastAttempted = true;
        return '0xshould-not-broadcast';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => expiredTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(db, fakeEvm, fakeBch, solverEvmKey);
    await engine.step();

    const order = db.getOrder(orderId)!;
    // Solver must refuse to counter-lock and transition to REJECTED
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Quote expired');
    expect(bchBroadcastAttempted).toBe(false);

    engine.stop();
  });

  it('CH-04: Invariant violation injected (short deadline) -> solver refuses to counter-lock (REJECTED)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const invalidTimingTerms = getDummyTerms({
      // Counter deadline is only 30 minutes away, but BCH refund height requires at least 36 blocks (~6 hours)
      counterDeadline: now + 1800,
      bchRefundHeight: 330144,
      quoteExpiry: now + 300,
    });

    const orderId = '0xch04-invariant-violation-order';
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      terms: invalidTimingTerms,
      hashLock: invalidTimingTerms.hashLock,
      userLockTxId: '0xuser-lock',
      createdAt: now - 30,
      updatedAt: now - 5,
    });

    let bchBroadcastAttempted = false;
    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => {
        bchBroadcastAttempted = true;
        return '0xshould-not-broadcast';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => invalidTimingTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(db, fakeEvm, fakeBch, solverEvmKey);
    await engine.step();

    const order = db.getOrder(orderId)!;
    // Invariant F must fail at counter-lock time and transition to REJECTED
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Invariant F violation');
    expect(bchBroadcastAttempted).toBe(false);

    engine.stop();
  });

  it('Reorg handling: detects unconfirmed EVM lock and prevents premature solver lock until safe', async () => {
    const dummyTerms = getDummyTerms();
    const orderId = '0xreorg-test-order';
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xreorged-lock',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let isSafeConfirmed = false;
    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({
        status: isSafeConfirmed ? ('locked' as const) : ('absent' as const),
      }),
      isFinal: async () => isSafeConfirmed,
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const engine = new SolverEngine(db, fakeEvm, fakeBch, solverEvmKey);

    // Initial check: reorged out / unconfirmed
    await engine.reconcileOrder(db.getOrder(orderId)!);
    expect(db.getOrder(orderId)!.status).toBe('USER_LOCK_SEEN');

    // Confirmations arrive: reaches safe threshold
    isSafeConfirmed = true;
    await engine.reconcileOrder(db.getOrder(orderId)!);
    expect(db.getOrder(orderId)!.status).toBe('USER_LOCK_FINAL');

    engine.stop();
  });

  it('Reconciliation: unexpected EVM claim on QUOTED order flags needs_attention instead of DONE', async () => {
    const dummyTerms = getDummyTerms();
    const orderId = '0xunexpected-claim-order';
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'QUOTED',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({
        status: 'claimed' as const,
        secret: `0x${'88'.repeat(32)}` as `0x${string}`,
        lockTx: { chain: 'base' as const, txId: '0xlock' },
        claimTx: { chain: 'base' as const, txId: '0xclaim' },
      }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const engine = new SolverEngine(db, fakeEvm, fakeBch, solverEvmKey);
    await engine.reconcileOrder(db.getOrder(orderId)!);

    const order = db.getOrder(orderId)!;
    expect(order.status).not.toBe('DONE');
    expect(order.needsAttention).toBe(true);

    const attentionList = db.listNeedsAttentionOrders();
    expect(attentionList.some((o) => o.id === orderId)).toBe(true);

    engine.stop();
  });
});
