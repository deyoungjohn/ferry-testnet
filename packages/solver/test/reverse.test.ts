import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { sha256 } from 'viem';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { BchQuorumClient } from '../src/bch/quorum-client.js';
import { parseOrderTerms, orderId as computeOrderId } from '@ferry/core';
import { encodeHtlcParameters, buildClaimTransaction } from '@ferry/htlc-bch';
import type { ElectrumUtxo } from '../src/bch/types.js';

describe('Reverse Swap Engine (BCH_TO_COUNTER)', () => {
  let db: SolverDatabase;
  let tempDbPath: string;

  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';
  const solverBchLockingBytecode =
    '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac' as const;

  beforeEach(() => {
    tempDbPath = path.join(
      process.cwd(),
      `test-reverse-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new SolverDatabase(tempDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  });

  function getDummyReverseTerms(
    overrides?: Partial<Parameters<typeof parseOrderTerms>[0]>,
  ) {
    const now = Math.floor(Date.now() / 1000);
    return parseOrderTerms({
      version: 1,
      direction: 'BCH_TO_COUNTER',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'aa'.repeat(32)}`,
      bchTokenAmount: 2500n, // $25.00
      counterAmount: 24850000n, // $24.85
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
      solverBchLockingBytecode,
      hashLock: `0x${'bb'.repeat(32)}`,
      counterDeadline: now + 6 * 3600, // 6 hours
      bchRefundHeight: 330144, // tip + 144
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'reverse-quote-1',
      quoteExpiry: now + 120,
      ...overrides,
    });
  }

  it('Happy path: user BCH lock seen -> invariant R check -> solver EVM counter-lock -> user claim -> solver BCH claim -> DONE', async () => {
    const secret = `0x${'33'.repeat(32)}` as const;
    const hashLock = sha256(secret);
    const terms = getDummyReverseTerms({ hashLock });
    const orderId = computeOrderId(terms);

    let evmLockStatus: 'absent' | 'locked' | 'claimed' | 'refunded' = 'absent';
    const recordedEvmCalls: string[] = [];
    const recordedBchBroadcasts: string[] = [];

    const fakeEvm = {
      address: solverAddress,
      lockId: (sender: string, hLock: string) =>
        sha256(`0x${sender.slice(2)}${hLock.slice(2)}`),
      getLock: async () => {
        if (evmLockStatus === 'absent') return { status: 'absent' as const };
        if (evmLockStatus === 'locked') {
          return {
            status: 'locked' as const,
            lockTx: { chain: 'base' as const, txId: '0xsolver-evm-lock' },
            owner: solverAddress,
            recipient: terms.userCounterAddress,
            asset: terms.counterAsset,
            amount: terms.counterAmount,
            hashLock: terms.hashLock,
            deadline: terms.counterDeadline,
          };
        }
        if (evmLockStatus === 'claimed') {
          return {
            status: 'claimed' as const,
            claimTx: { chain: 'base' as const, txId: '0xuser-evm-claim' },
            secret,
          };
        }
        return {
          status: 'refunded' as const,
          refundTx: { chain: 'base' as const, txId: '0xsolver-evm-refund' },
        };
      },
      isFinal: async () => true,
      lock: async () => {
        recordedEvmCalls.push('lock');
        evmLockStatus = 'locked';
        return { chain: 'base' as const, txId: '0xsolver-evm-lock' };
      },
      claim: async () => {
        recordedEvmCalls.push('claim');
        evmLockStatus = 'claimed';
        return { chain: 'base' as const, txId: '0xuser-evm-claim' };
      },
      refund: async () => {
        recordedEvmCalls.push('refund');
        evmLockStatus = 'refunded';
        return { chain: 'base' as const, txId: '0xsolver-evm-refund' };
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const bchUtxos: ElectrumUtxo[] = [];
    const bchHistory: Array<{ height: number; tx_hash: string }> = [];

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => bchUtxos,
      getHistory: async () => bchHistory,
      broadcast: async (txHex: string) => {
        recordedBchBroadcasts.push(txHex);
        return '0xsolver-bch-claim-tx';
      },
      broadcastTransaction: async (txHex: string) => {
        recordedBchBroadcasts.push(txHex);
        return '0xsolver-bch-claim-tx';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const engine = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
      'testnet',
    );

    // 1. Initial state: QUOTED
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 2. User funds BCH HTLC address
    const userLockTxId = '11'.repeat(32);
    bchUtxos.push({
      height: 330001,
      tx_hash: userLockTxId,
      tx_pos: 0,
      value: 3000,
      token_data: {
        category: 'aa'.repeat(32),
        amount: '2500',
      },
    });

    // 3. Engine steps: discovers BCH lock, verifies invariant R, and locks EVM
    await engine.step();

    let order = db.getOrder(orderId)!;
    expect(order.userLockTxId).toBe(userLockTxId);
    expect(order.status).toBe('SOLVER_LOCK_SEEN');
    expect(recordedEvmCalls).toContain('lock');

    // 4. User claims on EVM (reveals secret)
    evmLockStatus = 'claimed';
    await engine.step();

    order = db.getOrder(orderId)!;
    expect(order.status).toBe('SOLVER_CLAIM_BROADCAST');
    expect(order.secret).toBe(secret);
    expect(recordedBchBroadcasts.length).toBeGreaterThan(0);

    // 5. BCH claim confirms on chain
    bchHistory.push({
      height: 330002,
      tx_hash: order.solverClaimTxId!,
    });

    await engine.step();

    order = db.getOrder(orderId)!;
    expect(order.status).toBe('DONE');
  });

  it('Quote expiry before user lock: engine rejects order without counter-locking', async () => {
    const expiredTerms = getDummyReverseTerms({
      quoteExpiry: Math.floor(Date.now() / 1000) - 10,
    });
    const orderId = computeOrderId(expiredTerms);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        throw new Error('Lock should not be called');
      },
      watch: () => () => {},
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      terms: expiredTerms,
      hashLock: expiredTerms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('EXPIRED');
  });

  it('Invariant R failure at counter-lock time: engine rejects order', async () => {
    const terms = getDummyReverseTerms({
      // bchRefundHeight only 50 blocks above tip -> violates minReverseRemainingBlocks (108)
      bchRefundHeight: 330050,
    });
    const orderId = computeOrderId(terms);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        throw new Error('Lock must not be called when Invariant R fails');
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const userLockTxId = '22'.repeat(32);
    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          height: 330001,
          tx_hash: userLockTxId,
          tx_pos: 0,
          value: 3000,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '2500',
          },
        },
      ],
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_LOCK_FINAL',
      userLockTxId,
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Invariant R');
  });

  it('Solver EVM refund after counterDeadline: order reaches SOLVER_REFUNDED', async () => {
    const terms = getDummyReverseTerms({
      counterDeadline: Math.floor(Date.now() / 1000) - 100, // already passed
    });
    const orderId = computeOrderId(terms);
    let evmRefundCalled = false;

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({
        status: 'locked' as const,
        lockTx: { chain: 'base' as const, txId: '0xsolver-evm-lock' },
        owner: solverAddress,
        recipient: terms.userCounterAddress,
        asset: terms.counterAsset,
        amount: terms.counterAmount,
        hashLock: terms.hashLock,
        deadline: terms.counterDeadline,
      }),
      isFinal: async () => true,
      refund: async () => {
        evmRefundCalled = true;
        return { chain: 'base' as const, txId: '0xsolver-evm-refund' };
      },
      watch: () => () => {},
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'SOLVER_LOCK_SEEN',
      solverLockTxId: '0xsolver-evm-lock',
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    expect(evmRefundCalled).toBe(true);
    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('SOLVER_REFUNDED');
    expect(order.solverRefundTxId).toBe('0xsolver-evm-refund');
  });

  it('CH-01: Shared write-ahead adopts existing solver BCH claim across process restarts without duplicates', async () => {
    const secret = `0x${'44'.repeat(32)}` as const;
    const hashLock = sha256(secret);
    const terms = getDummyReverseTerms({ hashLock });
    const orderId = computeOrderId(terms);
    const userLockTxId = '33'.repeat(32);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'claimed' as const, secret }),
      isFinal: async () => true,
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    let broadcastCount = 0;
    const bchUtxos: ElectrumUtxo[] = [
      {
        height: 330001,
        tx_hash: userLockTxId,
        tx_pos: 0,
        value: 3000,
        token_data: {
          category: 'aa'.repeat(32),
          amount: '2500',
        },
      },
    ];

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => bchUtxos,
      getHistory: async () => [],
      broadcast: async () => {
        broadcastCount++;
        return '0xclaim-bch-tx';
      },
      broadcastTransaction: async () => {
        broadcastCount++;
        return '0xclaim-bch-tx';
      },
      subscribeScriptHash: async () => {},
      unsubscribeScriptHash: () => {},
    } as unknown as BchQuorumClient;

    const engine1 = new SolverEngine(
      db,
      fakeEvm,
      fakeBch,
      solverEvmKey,
      sampleWif,
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'USER_CLAIM_SEEN',
      userLockTxId,
      secret,
      secretSource: 'on_chain_claim',
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Run first step: executes write-ahead intent and broadcasts claim
    await engine1.step();
    expect(broadcastCount).toBe(1);

    const orderAfterFirst = db.getOrder(orderId)!;
    expect(orderAfterFirst.status).toBe('SOLVER_CLAIM_BROADCAST');
    const claimTxId = orderAfterFirst.solverClaimTxId!;

    // Now simulate restart: new engine instance on the same DB
    // On-chain history confirms the transaction is on-chain
    const fakeBchRestart = {
      ...fakeBch,
      getHistory: async () => [{ height: 330005, tx_hash: claimTxId }],
    } as unknown as BchQuorumClient;

    const engine2 = new SolverEngine(
      db,
      fakeEvm,
      fakeBchRestart,
      solverEvmKey,
      sampleWif,
      'testnet',
    );

    // Restart engine processes order: adopts without broadcasting a second time
    await engine2.step();
    expect(broadcastCount).toBe(1); // No second broadcast!

    const finalOrder = db.getOrder(orderId)!;
    expect(finalOrder.status).toBe('DONE');
  });

  it(': Lock carry under-funded: engine rejects order with INVALID_TERMS', async () => {
    const terms = getDummyReverseTerms({ bchCarrySats: 3000n });
    const orderId = computeOrderId(terms);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        throw new Error(
          'EVM lock must not be called when carry is under-funded',
        );
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          height: 330001,
          tx_hash: '33'.repeat(32),
          tx_pos: 0,
          value: 1000, // Only 1,000 sats < 3,000 required bchCarrySats!
          token_data: {
            category: 'aa'.repeat(32),
            amount: '2500',
          },
        },
      ],
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain(
      'Lock carry 1000 sats is below required 3000 sats',
    );
  });

  it(': Token amount over-funded: engine rejects order with INVALID_TERMS', async () => {
    const terms = getDummyReverseTerms({ bchTokenAmount: 2500n });
    const orderId = computeOrderId(terms);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        throw new Error(
          'EVM lock must not be called when token amount is mismatched',
        );
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          height: 330001,
          tx_hash: '44'.repeat(32),
          tx_pos: 0,
          value: 3000,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '3000', // Over-funded: 3000 !== 2500!
          },
        },
      ],
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain(
      'Token amount 3000 does not match exact quoted amount 2500',
    );
  });

  it(': Fast-lane double-spend proof detected: engine rejects order without counter-locking', async () => {
    const terms = getDummyReverseTerms({ bchTokenAmount: 2000n }); // $20.00 <= $25
    const orderId = computeOrderId(terms);
    const unconfirmedTxId = '55'.repeat(32);

    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () => ({ status: 'absent' as const }),
      isFinal: async () => true,
      lock: async () => {
        throw new Error(
          'Counter-lock must never be called when DSProof is detected',
        );
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          height: 0, // Unconfirmed 0-conf lock
          tx_hash: unconfirmedTxId,
          tx_pos: 0,
          value: 3000,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '2000',
          },
        },
      ],
      getDSProof: async (txid: string) => {
        // Return a detected double-spend proof object!
        return { txid, proof: '0xmock-dsproof-data' };
      },
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
      'testnet',
    );

    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      lane: 'fast',
      fastOptIn: true,
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await engine.step();

    const order = db.getOrder(orderId)!;
    expect(order.status).toBe('REJECTED');
    expect(order.rejectionReason).toContain(
      'Double-spend proof detected on user lock',
    );
  });

  it(': Fast-lane uncontested lock waits for 5000ms window before finalization', async () => {
    const terms = getDummyReverseTerms({ bchTokenAmount: 2000n });
    const orderId = computeOrderId(terms);
    const unconfirmedTxId = '66'.repeat(32);

    let evmLockCalled = false;
    const fakeEvm = {
      address: solverAddress,
      lockId: (s: string, h: string) => sha256(`0x${s.slice(2)}${h.slice(2)}`),
      getLock: async () =>
        evmLockCalled
          ? {
              status: 'locked' as const,
              lockTx: {
                chain: 'base' as const,
                txId: '0xmock-evm-counter-lock',
              },
              owner: solverAddress,
              recipient: terms.userCounterAddress,
              asset: terms.counterAsset,
              amount: terms.counterAmount,
              hashLock: terms.hashLock,
              deadline: terms.counterDeadline,
            }
          : { status: 'absent' as const },
      isFinal: async () => true,
      lock: async () => {
        evmLockCalled = true;
        return { chain: 'base' as const, txId: '0xmock-evm-counter-lock' };
      },
      watch: () => () => {},
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [
        {
          height: 0, // Unconfirmed
          tx_hash: unconfirmedTxId,
          tx_pos: 0,
          value: 3000,
          token_data: {
            category: 'aa'.repeat(32),
            amount: '2000',
          },
        },
      ],
      getDSProof: async () => null, // Clear of proofs
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
      'testnet',
    );

    // Initial order: first seen right now (elapsed 0 ms < 5000 ms window)
    db.saveOrder({
      id: orderId,
      direction: 'BCH_TO_COUNTER',
      status: 'QUOTED',
      lane: 'fast',
      fastOptIn: true,
      firstSeenAt: Date.now(),
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Step 1: should see user lock, but NOT finalize it because elapsed < 5000ms
    await engine.step();
    let order = db.getOrder(orderId)!;
    expect(order.status).toBe('USER_LOCK_SEEN');
    expect(evmLockCalled).toBe(false);

    // Step 2: simulate time passing beyond the 5000 ms window (e.g. 6000 ms ago)
    order.firstSeenAt = Date.now() - 6000;
    db.saveOrder(order);

    await engine.step();
    order = db.getOrder(orderId)!;
    expect(order.status).toBe('SOLVER_LOCK_SEEN');
    expect(evmLockCalled).toBe(true);
  });

  describe('Reverse Chaos & Fault Injection (CH-01, CH-02, CH-03, CH-04)', () => {
    it('CH-01-rev: Fault before EVM lock: restart locks EVM without duplication', async () => {
      const terms = getDummyReverseTerms();
      const orderId = computeOrderId(terms);
      let evmLockCount = 0;

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () =>
          evmLockCount === 0
            ? { status: 'absent' as const }
            : { status: 'locked' as const },
        isFinal: async () => true,
        lock: async () => {
          evmLockCount++;
          return { chain: 'base' as const, txId: '0xmock-evm-lock' };
        },
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => [
          {
            height: 330001,
            tx_hash: '77'.repeat(32),
            tx_pos: 0,
            value: 3000,
            token_data: { category: 'aa'.repeat(32), amount: '2500' },
          },
        ],
        getHistory: async () => [],
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      // Seed order as USER_LOCK_FINAL (as if killed right before EVM lock)
      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_LOCK_FINAL',
        terms,
        hashLock: terms.hashLock,
        userLockTxId: '77'.repeat(32),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.step();
      expect(evmLockCount).toBe(1);
      const order = db.getOrder(orderId)!;
      expect(order.status).toBe('SOLVER_LOCK_SEEN');
    });

    it('CH-01-rev: Fault after EVM lock: restart adopts locked state without duplicate lock', async () => {
      const terms = getDummyReverseTerms();
      const orderId = computeOrderId(terms);
      let evmLockCount = 0;

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () => ({
          status: 'locked' as const,
          lockTx: { chain: 'base' as const, txId: '0xexisting-evm-lock' },
          owner: solverAddress,
          recipient: terms.userCounterAddress,
          asset: terms.counterAsset,
          amount: terms.counterAmount,
          hashLock: terms.hashLock,
          deadline: terms.counterDeadline,
        }),
        isFinal: async () => true,
        lock: async () => {
          evmLockCount++;
          return { chain: 'base' as const, txId: '0xduplicate-lock' };
        },
        watch: () => () => {},
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

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_LOCK_FINAL',
        terms,
        hashLock: terms.hashLock,
        userLockTxId: '77'.repeat(32),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.step();
      expect(evmLockCount).toBe(0); // Zero duplicate calls!
      const order = db.getOrder(orderId)!;
      expect(order.status).toBe('SOLVER_LOCK_SEEN');
    });

    it('CH-01-rev: Fault before BCH claim broadcast: restart broadcasts saved hex exactly once', async () => {
      const secret = `0x${'55'.repeat(32)}` as const;
      const terms = getDummyReverseTerms({ hashLock: sha256(secret) });
      const orderId = computeOrderId(terms);
      const userLockTxId = '88'.repeat(32);
      const bchBroadcasts: string[] = [];

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () => ({
          status: 'claimed' as const,
          claimTx: { chain: 'base' as const, txId: '0xclaim-tx' },
          secret,
        }),
        isFinal: async () => true,
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => [
          {
            height: 330001,
            tx_hash: userLockTxId,
            tx_pos: 0,
            value: 3000,
            token_data: { category: 'aa'.repeat(32), amount: '2500' },
          },
        ],
        getHistory: async () => [],
        broadcast: async (txHex: string) => {
          bchBroadcasts.push(txHex);
          return '0xsolver-bch-claim';
        },
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      // Seed order in USER_CLAIM_SEEN with pre-persisted intent (as if killed right after writing intent)
      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_CLAIM_SEEN',
        terms,
        hashLock: terms.hashLock,
        userLockTxId,
        secret,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const bchParams = encodeHtlcParameters(terms);
      const claimResult = buildClaimTransaction({
        params: bchParams,
        utxo: {
          txid: userLockTxId,
          vout: 0,
          satoshis: terms.bchCarrySats,
        },
        secret,
        network: 'chipnet',
      });

      db.recordActionIntent(orderId, 'SOLVER_CLAIM', {
        txid: claimResult.txid,
        txHex: claimResult.txHex,
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.step();
      expect(bchBroadcasts).toEqual([claimResult.txHex]);
      const order = db.getOrder(orderId)!;
      expect(order.status).toBe('SOLVER_CLAIM_BROADCAST');
    });

    it('CH-02-rev: Electrum drop mid-swap falls over and completes reverse swap', async () => {
      const secret = `0x${'aa'.repeat(32)}` as const;
      const terms = getDummyReverseTerms({ hashLock: sha256(secret) });
      const orderId = computeOrderId(terms);
      let electrumFails = true;

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () => ({
          status: 'claimed' as const,
          claimTx: { chain: 'base' as const, txId: '0xclaim' },
          secret,
        }),
        isFinal: async () => true,
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => {
          if (electrumFails) {
            throw new Error('Electrum connection dropped');
          }
          return [
            {
              height: 330001,
              tx_hash: '99'.repeat(32),
              tx_pos: 0,
              value: 3000,
              token_data: { category: 'aa'.repeat(32), amount: '2500' },
            },
          ];
        },
        getHistory: async () => [],
        broadcast: async () => '0xclaim-tx',
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_CLAIM_SEEN',
        terms,
        hashLock: terms.hashLock,
        userLockTxId: '99'.repeat(32),
        secret,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      // Step with Electrum dropped: engine catches and logs error, does not crash
      await engine.step();
      let order = db.getOrder(orderId)!;
      expect(order.status).toBe('USER_CLAIM_SEEN');

      // Electrum recovers
      electrumFails = false;
      await engine.step();
      order = db.getOrder(orderId)!;
      expect(order.status).toBe('SOLVER_CLAIM_BROADCAST');
    });

    it('CH-03-rev: User funds BCH HTLC after quote expiry -> solver refuses to counter-lock (REJECTED)', async () => {
      const terms = getDummyReverseTerms({
        quoteExpiry: Math.floor(Date.now() / 1000) - 10,
      });
      const orderId = computeOrderId(terms);
      let evmLockCalled = false;

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () => ({ status: 'absent' as const }),
        isFinal: async () => true,
        lock: async () => {
          evmLockCalled = true;
          return { chain: 'base' as const, txId: '0xlate-lock' };
        },
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => [
          {
            height: 330001,
            tx_hash: '12'.repeat(32),
            tx_pos: 0,
            value: 3000,
            token_data: { category: 'aa'.repeat(32), amount: '2500' },
          },
        ],
        getHistory: async () => [],
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'QUOTED',
        terms,
        hashLock: terms.hashLock,
        createdAt: Date.now() - 30000,
        updatedAt: Date.now() - 30000,
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.step();
      expect(evmLockCalled).toBe(false);
      const order = db.getOrder(orderId)!;
      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain(
        'Quote expired before user lock finalized',
      );
    });

    it('CH-04-rev: Invariant R violation injected -> solver refuses to counter-lock (REJECTED)', async () => {
      // Invariant R requires: bchRefundHeight - currentTip >= 108
      // Inject short refund height (only 50 blocks above tip)
      const terms = getDummyReverseTerms({
        bchRefundHeight: 330050,
      });
      const orderId = computeOrderId(terms);
      let evmLockCalled = false;

      const fakeEvm = {
        address: solverAddress,
        lockId: (s: string, h: string) =>
          sha256(`0x${s.slice(2)}${h.slice(2)}`),
        getLock: async () => ({ status: 'absent' as const }),
        isFinal: async () => true,
        lock: async () => {
          evmLockCalled = true;
          return { chain: 'base' as const, txId: '0xinvalid-lock' };
        },
        watch: () => () => {},
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => [
          {
            height: 330001,
            tx_hash: '34'.repeat(32),
            tx_pos: 0,
            value: 3000,
            token_data: { category: 'aa'.repeat(32), amount: '2500' },
          },
        ],
        getHistory: async () => [],
        subscribeScriptHash: async () => {},
        unsubscribeScriptHash: () => {},
      } as unknown as BchQuorumClient;

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'QUOTED',
        terms,
        hashLock: terms.hashLock,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const engine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.step();
      expect(evmLockCalled).toBe(false);
      const order = db.getOrder(orderId)!;
      expect(order.status).toBe('REJECTED');
      expect(order.rejectionReason).toContain('Invariant R violation');
    });
  });
});
