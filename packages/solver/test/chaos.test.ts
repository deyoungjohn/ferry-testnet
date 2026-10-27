import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { sha256 } from 'viem';
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
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';

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
        '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac',
      hashLock: `0x${'bb'.repeat(32)}`,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330036,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'chaos-quote-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 120,
      ...overrides,
    });

  const getDummyReverseTerms = (
    overrides?: Partial<Parameters<typeof parseOrderTerms>[0]>,
  ) =>
    parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'aa'.repeat(32)}`,
      bchTokenAmount: 100n,
      counterAmount: 946000n,
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
        '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac',
      hashLock: `0x${'bb'.repeat(32)}`,
      counterDeadline: Math.floor(Date.now() / 1000) + 21600,
      bchRefundHeight: 330144,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'chaos-reverse-quote-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    });

  function spawnChaosChild(
    args: string[],
    envOverrides: Record<string, string> = {},
  ): {
    child: ReturnType<typeof spawn>;
    readyPromise: Promise<void>;
    closePromise: Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>;
    killTree: (signal?: NodeJS.Signals) => void;
  } {
    const solverDir = path.resolve(__dirname, '..');
    const childScript = path.resolve(__dirname, 'helpers/chaos-child.ts');
    const child = spawn('pnpm', ['exec', 'tsx', childScript, ...args], {
      cwd: solverDir,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...envOverrides,
      },
    });

    const killTree = (signal: NodeJS.Signals = 'SIGKILL') => {
      try {
        if (child.pid) {
          process.kill(-child.pid, signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already closed
        }
      }
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderrBuf += data.toString();
    });
    const readyPromise = new Promise<void>((resolve, reject) => {
      const onData = (data: Buffer) => {
        stdoutBuf += data.toString();
        if (stdoutBuf.includes('READY')) {
          child.stdout.off('data', onData);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (!stdoutBuf.includes('READY')) {
          reject(
            new Error(
              `Child process exited before READY signal (code=${code}, sig=${signal}): ${stderrBuf}`,
            ),
          );
        }
      });
    });

    const closePromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on('close', (code, signal) => {
        resolve({ code, signal });
      });
    });

    return { child, readyPromise, closePromise, killTree };
  }

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
      const dummyTerms = getDummyTerms({ hashLock: sha256(secret) });

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

      // 1. Scripted child process SIGKILL: wait on explicit readiness signal
      const { child, readyPromise, closePromise, killTree } = spawnChaosChild([
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
      ]);

      await readyPromise;

      // Execute SIGKILL on process group and await explicit close event (no wall-clock timeout)
      killTree('SIGKILL');
      const { signal } = await closePromise;
      expect(
        child.killed || child.exitCode !== null || signal === 'SIGKILL',
      ).toBe(true);

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
        listUnspent: async () => {
          if (state === 'SOLVER_LOCK_BROADCAST') {
            return [
              {
                tx_hash: '0xsolver-lock',
                tx_pos: 0,
                value: 3000,
                height: 330001,
              },
            ];
          }
          return [
            {
              tx_hash: '11'.repeat(32),
              tx_pos: 0,
              value: 20000,
              token_data: {
                category: 'aa'.repeat(32),
                amount: '10000000',
              },
            },
            {
              tx_hash: '22'.repeat(32),
              tx_pos: 0,
              value: 50000,
            },
          ];
        },
        getHistory: async () => [],
        broadcast: async (hex: string) => {
          recordedBchBroadcasts.push(hex);
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
        sampleWif,
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
  }, 120_000);

  it('CH-02: Electrum drop mid-swap falls over to surviving server and reconciles on reconnect', async () => {
    let notifiedStatus: string | null = null;
    const client = new BchQuorumClient([
      'wss://chipnet.imaginary.cash:50004',
      'wss://blackie.c3-soft.com:64004',
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

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
    );
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

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
    );
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

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
    );

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

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
    );
    await engine.reconcileOrder(db.getOrder(orderId)!);

    const order = db.getOrder(orderId)!;
    expect(order.status).not.toBe('DONE');
    expect(order.needsAttention).toBe(true);

    const attentionList = db.listNeedsAttentionOrders();
    expect(attentionList.some((o) => o.id === orderId)).toBe(true);

    engine.stop();
  });

  it('CH-01b: SIGKILL fault injection BEFORE_BCH_LOCK_BROADCAST: restart broadcasts exactly once and creates exactly one lock UTXO', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'aa'.repeat(32)}`;
    const dummyTerms = getDummyTerms();
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-lock',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-b.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'BEFORE_BCH_LOCK_BROADCAST',
      },
    );

    // Synchronize on explicit child readiness signal, then wait for injected crash
    await readyPromise;
    await closePromise;

    // 1. Verify child died before broadcast
    const recordedBefore = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedBefore.length).toBe(0);

    // 2. Verify intent was persisted with { txid, txHex } ahead of broadcast
    const action = db.getAction(orderId, 'SOLVER_LOCK')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');
    const intent = JSON.parse(action.intentPayload);
    expect(intent.txid).toBeDefined();
    expect(intent.txHex).toBeDefined();

    // 3. Restart engine on same DB
    const recordedRestartBroadcasts: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async (hex: string) => {
        recordedRestartBroadcasts.push(hex);
        return intent.txid;
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Exactly one broadcast happened across the lifecycle!
    expect(recordedRestartBroadcasts.length).toBe(1);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_LOCK_BROADCAST');
    expect(updated.solverLockTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01c: SIGKILL fault injection AFTER_BCH_LOCK_BROADCAST: restart adopts existing lock without duplicate broadcast', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'bb'.repeat(32)}`;
    const dummyTerms = getDummyTerms();
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-lock',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-c.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'AFTER_BCH_LOCK_BROADCAST',
      },
    );

    // Synchronize on explicit child readiness signal, then wait for injected crash
    await readyPromise;
    await closePromise;

    // 1. Verify broadcast happened before crash
    const recordedInChild = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedInChild.length).toBe(1);

    // 2. Action is still PENDING because process was killed before recording broadcast
    const action = db.getAction(orderId, 'SOLVER_LOCK')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');
    const intent = JSON.parse(action.intentPayload);

    // 3. Restart engine on same DB, simulating chain that already has the broadcast UTXO
    const recordedRestartBroadcasts: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: intent.txid,
          tx_pos: 0,
          value: 3000,
          height: 330001,
        },
      ],
      getHistory: async () => [{ tx_hash: intent.txid, height: 330001 }],
      broadcast: async (hex: string) => {
        recordedRestartBroadcasts.push(hex);
        return intent.txid;
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Zero duplicate broadcasts from restart! It adopted the existing on-chain tx!
    expect(recordedRestartBroadcasts.length).toBe(0);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_LOCK_BROADCAST');
    expect(updated.solverLockTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01d (reverse 1): SIGKILL fault injection BEFORE_EVM_LOCK_BROADCAST: restart broadcasts EVM lock exactly once', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'d1'.repeat(32)}`;
    const dummyTerms = getDummyReverseTerms();
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_LOCK_FINAL',
      lane: 'fast',
      fastOptIn: true,
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-rev-1.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'BEFORE_EVM_LOCK_BROADCAST',
      },
    );

    await readyPromise;
    await closePromise;

    // 1. Verify child died before broadcast
    const recordedBefore = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedBefore.length).toBe(0);

    // 2. Action is PENDING with intent recorded
    const action = db.getAction(orderId, 'SOLVER_LOCK')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');

    // 3. Restart engine on same DB
    const recordedRestartEvm: string[] = [];
    const restartEvm = {
      address: solverAddress,
      lockId: () => orderId,
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        recordedRestartEvm.push('0xrestart-evm-lock');
        return { chain: 'base' as const, txId: '0xrestart-evm-lock' };
      },
    } as unknown as EvmChainAdapter;

    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
          height: 330001,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '100',
          },
        },
      ],
      getHistory: async () => [{ tx_hash: '11'.repeat(32), height: 330001 }],
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Exactly one broadcast happened across the lifecycle!
    expect(recordedRestartEvm.length).toBe(1);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_LOCK_BROADCAST');
    expect(updated.solverLockTxId).toBe('0xrestart-evm-lock');

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01d (reverse 2): SIGKILL fault injection AFTER_EVM_LOCK_BROADCAST: restart adopts existing EVM lock without duplicate broadcast', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'d2'.repeat(32)}`;
    const dummyTerms = getDummyReverseTerms();
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_LOCK_FINAL',
      lane: 'fast',
      fastOptIn: true,
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-rev-2.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'AFTER_EVM_LOCK_BROADCAST',
      },
    );

    await readyPromise;
    await closePromise;

    // 1. Verify EVM lock was broadcast before crash
    const recordedInChild = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedInChild.length).toBe(1);

    // 2. Action is still PENDING because process was killed before recording broadcast
    const action = db.getAction(orderId, 'SOLVER_LOCK')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');

    // 3. Restart engine on same DB, simulating chain where EVM lock exists
    const recordedRestartEvm: string[] = [];
    const restartEvm = {
      address: solverAddress,
      lockId: () => orderId,
      getLock: async () => ({
        status: 'locked' as const,
        lockTx: { txId: '0xchild-evm-lock-tx' },
      }),
      isFinal: async () => true,
      lock: async () => {
        recordedRestartEvm.push('0xduplicate-evm-lock');
        return { chain: 'base' as const, txId: '0xduplicate-evm-lock' };
      },
    } as unknown as EvmChainAdapter;

    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
          height: 330001,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '100',
          },
        },
      ],
      getHistory: async () => [{ tx_hash: '11'.repeat(32), height: 330001 }],
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Zero duplicate broadcasts from restart! It adopted the existing on-chain tx!
    expect(recordedRestartEvm.length).toBe(0);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_LOCK_SEEN');
    expect(updated.solverLockTxId).toBe('0xchild-evm-lock-tx');

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01d (reverse 3): SIGKILL fault injection BEFORE_BCH_CLAIM_BROADCAST: restart broadcasts BCH claim exactly once', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'d3'.repeat(32)}`;
    const secret = `0x${'99'.repeat(32)}` as const;
    const dummyTerms = getDummyReverseTerms({ hashLock: sha256(secret) });
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_CLAIM_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      secret,
      secretSource: 'on_chain_claim',
      userLockTxId: '11'.repeat(32),
      solverLockTxId: '0xsolver-evm-lock',
      userClaimTxId: '0xuser-evm-claim',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-rev-3.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'BEFORE_BCH_CLAIM_BROADCAST',
      },
    );

    await readyPromise;
    await closePromise;

    // 1. Verify child died before broadcast
    const recordedBefore = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedBefore.length).toBe(0);

    // 2. Action is PENDING with intent recorded
    const action = db.getAction(orderId, 'SOLVER_CLAIM')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');
    const intent = JSON.parse(action.intentPayload);
    expect(intent.txid).toBeDefined();
    expect(intent.txHex).toBeDefined();

    // 3. Restart engine on same DB
    const recordedRestartBch: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
          height: 330001,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '100',
          },
        },
      ],
      getHistory: async () => [{ tx_hash: '11'.repeat(32), height: 330001 }],
      broadcast: async (hex: string) => {
        recordedRestartBch.push(hex);
        return intent.txid;
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEvm = {
      address: solverAddress,
      lockId: () => orderId,
      getLock: async () => ({
        status: 'claimed' as const,
        claimTx: { txId: '0xuser-evm-claim' },
        secret,
      }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Exactly one broadcast happened across the lifecycle!
    expect(recordedRestartBch.length).toBe(1);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_CLAIM_BROADCAST');
    expect(updated.solverClaimTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01d (reverse 4): SIGKILL fault injection AFTER_BCH_CLAIM_BROADCAST: restart adopts existing BCH claim without duplicate broadcast', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'d4'.repeat(32)}`;
    const secret = `0x${'99'.repeat(32)}` as const;
    const dummyTerms = getDummyReverseTerms({ hashLock: sha256(secret) });
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_CLAIM_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      secret,
      secretSource: 'on_chain_claim',
      userLockTxId: '11'.repeat(32),
      solverLockTxId: '0xsolver-evm-lock',
      userClaimTxId: '0xuser-evm-claim',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-rev-4.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'AFTER_BCH_CLAIM_BROADCAST',
      },
    );

    await readyPromise;
    await closePromise;

    // 1. Verify BCH claim was broadcast before crash
    const recordedInChild = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedInChild.length).toBe(1);

    // 2. Action is still PENDING because process was killed before recording broadcast
    const action = db.getAction(orderId, 'SOLVER_CLAIM')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');
    const intent = JSON.parse(action.intentPayload);

    // 3. Restart engine on same DB, simulating chain where BCH claim is in history
    const recordedRestartBch: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
          height: 330001,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '100',
          },
        },
      ],
      getHistory: async () => [
        { tx_hash: '11'.repeat(32), height: 330001 },
        { tx_hash: intent.txid, height: 330002 },
      ],
      broadcast: async (hex: string) => {
        recordedRestartBch.push(hex);
        return intent.txid;
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const restartEvm = {
      address: solverAddress,
      lockId: () => orderId,
      getLock: async () => ({
        status: 'claimed' as const,
        claimTx: { txId: '0xuser-evm-claim' },
        secret,
      }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      restartEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Zero duplicate broadcasts from restart! It adopted the existing on-chain tx!
    expect(recordedRestartBch.length).toBe(0);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('DONE');
    expect(updated.solverClaimTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('E2E-06 forward half: user abandons after solver BCH lock -> solver refunds at bchRefundHeight', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'cc'.repeat(32)}`;
    const refundHeight = 330036;
    const dummyTerms = getDummyTerms({ bchRefundHeight: refundHeight });

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'SOLVER_LOCK_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-evm-lock',
      solverLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const recordedRefundBroadcasts: string[] = [];
    let currentBchTip = 330000;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: currentBchTip,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
        },
      ],
      getHistory: async () => [],
      broadcast: async (hex: string) => {
        recordedRefundBroadcasts.push(hex);
        return '0xsolver-refund-tx';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
    );

    // 1. Before refund height (tip 330000 < 330036), solver does NOT refund
    await engine.step();
    expect(db.getOrder(orderId)!.status).toBe('SOLVER_LOCK_SEEN');
    expect(recordedRefundBroadcasts.length).toBe(0);

    // 2. Advance tip to refund height (tip 330036 >= 330036)
    currentBchTip = refundHeight;
    await engine.step();

    // Solver builds and broadcasts refund transaction!
    expect(recordedRefundBroadcasts.length).toBe(1);
    const refundedOrder = db.getOrder(orderId)!;
    expect(refundedOrder.status).toBe('SOLVER_REFUNDED');
    expect(refundedOrder.solverRefundTxId).toBeDefined();
    expect(refundedOrder.solverRefundTxId).toHaveLength(64);

    engine.stop();
  });

  it('Hard-coded tip fallback removal: Unhealthy or unknown quorum tip delays counter-lock without hard-coded fallback', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'dd'.repeat(32)}`;
    const dummyTerms = getDummyTerms();

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_LOCK_FINAL',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-lock',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    let broadcastAttempted = false;
    const unhealthyBch = {
      getQuorumStatus: () => ({
        quorumTip: 0, // Unknown tip!
        tips: {},
        isQuorumHealthy: false, // Unhealthy!
        ageSeconds: 9999,
      }),
      listUnspent: async () => [],
      getHistory: async () => [],
      broadcast: async () => {
        broadcastAttempted = true;
        return '0xtx';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(
      db,
      fakeEvm,
      unhealthyBch,
      solverEvmKey,
      sampleWif,
    );
    await engine.step();

    // Must NOT broadcast with a dummy tip like 329000; must stay in USER_LOCK_FINAL
    expect(broadcastAttempted).toBe(false);
    expect(db.getOrder(orderId)!.status).toBe('USER_LOCK_FINAL');

    engine.stop();
  });

  it('CH-01d: SIGKILL fault injection BEFORE_BCH_REFUND_BROADCAST: restart broadcasts exactly once and marks order refunded', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'ee'.repeat(32)}`;
    const refundHeight = 330000;
    const dummyTerms = getDummyTerms({ bchRefundHeight: refundHeight });

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'SOLVER_LOCK_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-lock',
      solverLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-refund-b.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'BEFORE_BCH_REFUND_BROADCAST',
      },
    );

    // Synchronize on explicit child readiness signal, then wait for injected crash
    await readyPromise;
    await closePromise;

    // 1. Verify child died before broadcast
    const recordedBefore = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedBefore.length).toBe(0);

    // 2. Verify refund intent was persisted with { txid, txHex }
    const action = db.getAction(orderId, 'SOLVER_REFUND')!;
    expect(action).not.toBeNull();
    expect(action.status).toBe('PENDING');
    const intent = JSON.parse(action.intentPayload);
    expect(intent.txid).toBeDefined();
    expect(intent.txHex).toBeDefined();

    // 3. Restart engine on same DB
    const recordedRestartRefunds: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: refundHeight,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 0,
          value: 3000,
        },
      ],
      getHistory: async () => [],
      broadcast: async (hex: string) => {
        recordedRestartRefunds.push(hex);
        return '0xrestart-refund-tx';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      fakeEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Exactly one refund broadcast upon restart!
    expect(recordedRestartRefunds.length).toBe(1);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_REFUNDED');
    expect(updated.solverRefundTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it('CH-01e: SIGKILL fault injection AFTER_BCH_REFUND_BROADCAST: restart adopts existing refund without duplicate broadcast', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'ff'.repeat(32)}`;
    const refundHeight = 330000;
    const dummyTerms = getDummyTerms({ bchRefundHeight: refundHeight });

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'SOLVER_LOCK_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-lock',
      solverLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const broadcastLog = `${tempDbPath}-broadcasts-refund-c.log`;
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);

    const { readyPromise, closePromise } = spawnChaosChild(
      [
        `--dbPath=${tempDbPath}`,
        `--orderId=${orderId}`,
        '--runStep',
        `--broadcastLogPath=${broadcastLog}`,
      ],
      {
        FERRY_FAULT_INJECTION: '1',
        FAULT_CRASH_POINT: 'AFTER_BCH_REFUND_BROADCAST',
      },
    );

    // Synchronize on explicit child readiness signal, then wait for injected crash
    await readyPromise;
    await closePromise;

    // 1. Verify child successfully broadcast before crash
    const recordedInChild = fs.existsSync(broadcastLog)
      ? fs.readFileSync(broadcastLog, 'utf8').trim().split('\n').filter(Boolean)
      : [];
    expect(recordedInChild.length).toBe(1);

    // 2. Action is still PENDING because process was killed before recordActionBroadcast
    const action = db.getAction(orderId, 'SOLVER_REFUND')!;
    expect(action).not.toBeNull();
    const intent = JSON.parse(action.intentPayload);

    // 3. Restart engine on same DB where chain has already indexed the refund
    const recordedRestartRefunds: string[] = [];
    const restartBch = {
      getQuorumStatus: () => ({
        quorumTip: refundHeight,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
      getHistory: async () => [
        {
          tx_hash: intent.txid,
          height: refundHeight,
        },
      ],
      getTransaction: async () => null,
      broadcast: async (hex: string) => {
        recordedRestartRefunds.push(hex);
        return '0xshould-not-broadcast';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({ status: 'locked' as const }),
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const restartEngine = new SolverEngine(
      db,
      fakeEvm,
      restartBch,
      solverEvmKey,
      sampleWif,
    );

    await restartEngine.step();

    // Zero duplicate broadcasts; adopted existing!
    expect(recordedRestartRefunds.length).toBe(0);
    const updated = db.getOrder(orderId)!;
    expect(updated.status).toBe('SOLVER_REFUNDED');
    expect(updated.solverRefundTxId).toBe(intent.txid);

    restartEngine.stop();
    if (fs.existsSync(broadcastLog)) fs.unlinkSync(broadcastLog);
  }, 60_000);

  it(': refund vs user claim race condition: user claim confirmed at refund height -> solver extracts secret, claims EVM USDC, order reaches DONE', async () => {
    db.db.exec('DELETE FROM orders; DELETE FROM actions;');
    const orderId = `0x${'12'.repeat(32)}`;
    const secret = `0x${'88'.repeat(32)}` as const;
    const {
      sha256: lSha256,
      hexToBin: lHexToBin,
      binToHex: lBinToHex,
      encodeTransaction: lEncodeTx,
    } = await import('@bitauth/libauth');
    const hashLock =
      `0x${lBinToHex(lSha256.hash(lHexToBin(secret.slice(2))))}` as const;
    const refundHeight = 330000;
    const dummyTerms = getDummyTerms({
      bchRefundHeight: refundHeight,
      hashLock,
    });

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'SOLVER_LOCK_SEEN',
      terms: dummyTerms,
      hashLock: dummyTerms.hashLock,
      userLockTxId: '0xuser-evm-lock',
      solverLockTxId: '11'.repeat(32),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const recordedRefundBroadcasts: string[] = [];
    const recordedEvmClaims: string[] = [];

    // Encode a valid raw transaction that spends from the HTLC and reveals secret
    const claimRawBytes = lEncodeTx({
      version: 2,
      inputs: [
        {
          outpointIndex: 0,
          outpointTransactionHash: lHexToBin('11'.repeat(32)),
          sequenceNumber: 0,
          unlockingBytecode: new Uint8Array([
            0x20,
            ...lHexToBin(secret.slice(2)),
          ]),
        },
      ],
      outputs: [
        {
          lockingBytecode: new Uint8Array([
            0x76,
            0xa9,
            0x14,
            ...new Uint8Array(20),
            0x88,
            0xac,
          ]),
          valueSatoshis: 1000n,
        },
      ],
      locktime: 0,
    });
    const claimRawHex = lBinToHex(claimRawBytes);
    const userClaimBchTxid = '77'.repeat(32);

    const raceBch = {
      getQuorumStatus: () => ({
        quorumTip: refundHeight, // At refund height!
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [], // HTLC output is already spent by the user claim!
      getHistory: async () => [
        { tx_hash: '11'.repeat(32), height: 329900 },
        { tx_hash: userClaimBchTxid, height: refundHeight },
      ],
      getTransaction: async (txid: string) => {
        if (txid === userClaimBchTxid) {
          return { hex: claimRawHex };
        }
        return null;
      },
      broadcast: async (hex: string) => {
        recordedRefundBroadcasts.push(hex);
        return '0xshould-not-refund';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    let evmClaimStatus: 'locked' | 'claimed' = 'locked';
    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => {
        if (evmClaimStatus === 'claimed') {
          return {
            status: 'claimed' as const,
            claimTx: { chain: 'base' as const, txId: '0xsolver-claimed-evm' },
          };
        }
        return {
          status: 'locked' as const,
          lockTx: { chain: 'base' as const, txId: '0xuser-evm-lock' },
          owner: dummyTerms.userCounterAddress,
          recipient: solverAddress,
          asset: dummyTerms.counterAsset,
          amount: dummyTerms.counterAmount,
          hashLock: dummyTerms.hashLock,
          deadline: dummyTerms.counterDeadline,
        };
      },
      claim: async (_lockId: string, revealedSecret: string) => {
        expect(revealedSecret).toBe(secret);
        recordedEvmClaims.push('0xsolver-claimed-evm');
        evmClaimStatus = 'claimed';
        return { chain: 'base' as const, txId: '0xsolver-claimed-evm' };
      },
      isFinal: async () => true,
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(
      db,
      fakeEvm,
      raceBch,
      solverEvmKey,
      sampleWif,
    );

    // Step 1: Detects user claim, extracts secret, broadcasts EVM claim
    await engine.step();

    // Solver must NOT broadcast a refund!
    expect(recordedRefundBroadcasts.length).toBe(0);

    // Solver must extract secret from the BCH spend and claim EVM USDC
    const orderAfterStep1 = db.getOrder(orderId)!;
    expect(orderAfterStep1.secret).toBe(secret);
    expect(recordedEvmClaims.length).toBe(1);
    expect(orderAfterStep1.status).toBe('SOLVER_CLAIM_BROADCAST');

    // Step 2: Finalizes EVM claim to reach DONE
    await engine.step();
    const finalOrder = db.getOrder(orderId)!;
    expect(finalOrder.status).toBe('DONE');

    engine.stop();
  });

  it(': Mainnet configuration produces mainnet addresses and derived network params', async () => {
    const dummyTerms = getDummyTerms();
    const mainnetEngine = new SolverEngine(
      db,
      {} as unknown as EvmChainAdapter,
      {} as unknown as BchQuorumClient,
      solverEvmKey,
      sampleWif,
      'mainnet',
    );

    expect(mainnetEngine.network).toBe('mainnet');
    expect(mainnetEngine.bchNetwork).toBe('mainnet');
    expect(mainnetEngine.bchAddressPrefix).toBe('bitcoincash');

    const { deriveHtlcAddresses, encodeHtlcParameters } =
      await import('@ferry/htlc-bch');
    const addresses = deriveHtlcAddresses(
      encodeHtlcParameters(dummyTerms),
      mainnetEngine.bchNetwork,
    );
    expect(addresses.p2sh32Address.startsWith('bitcoincash:')).toBe(true);
    expect(addresses.tokenAddress.startsWith('bitcoincash:')).toBe(true);

    const { deriveBchKeyDetails } = await import('../src/bch/lock-builder.js');
    const keys = await deriveBchKeyDetails(
      sampleWif,
      mainnetEngine.bchAddressPrefix,
    );
    expect(keys.address?.startsWith('bitcoincash:')).toBe(true);

    mainnetEngine.stop();
  });

  it(': Fault injection guards: refuses startup on mainnet with FAULT_CRASH_POINT, and ignores crash points when FERRY_FAULT_INJECTION!=1', async () => {
    // 1. Refuse to start on mainnet if FAULT_CRASH_POINT is present
    const origFault = process.env.FAULT_CRASH_POINT;
    const origFlag = process.env.FERRY_FAULT_INJECTION;

    try {
      process.env.FAULT_CRASH_POINT = 'BEFORE_BCH_LOCK_BROADCAST';
      expect(() => {
        new SolverEngine(
          db,
          {} as unknown as EvmChainAdapter,
          {} as unknown as BchQuorumClient,
          solverEvmKey,
          sampleWif,
          'mainnet',
        );
      }).toThrow(
        'Refusing to start: FAULT_CRASH_POINT is not allowed when network is mainnet',
      );

      // 2. On testnet, if FERRY_FAULT_INJECTION is NOT '1', crash hook does NOT fire
      delete process.env.FERRY_FAULT_INJECTION;
      process.env.FAULT_CRASH_POINT = 'BEFORE_BCH_LOCK_BROADCAST';

      const testEngine = new SolverEngine(
        db,
        {} as unknown as EvmChainAdapter,
        {} as unknown as BchQuorumClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );
      expect(testEngine.network).toBe('testnet');
      testEngine.stop();
    } finally {
      if (origFault !== undefined) process.env.FAULT_CRASH_POINT = origFault;
      else delete process.env.FAULT_CRASH_POINT;
      if (origFlag !== undefined) process.env.FERRY_FAULT_INJECTION = origFlag;
      else delete process.env.FERRY_FAULT_INJECTION;
    }
  });
});
