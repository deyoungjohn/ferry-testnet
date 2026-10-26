import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { sha256 } from 'viem';
import {
  parseOrderTerms,
  orderId as computeOrderId,
  type TxRef,
} from '@ferry/core';
import { encodeHtlcParameters, buildClaimTransaction } from '@ferry/htlc-bch';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import type { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';

describe('BCH Claim History Reconciliation Safety Net & EVM Idempotency', () => {
  let db: SolverDatabase;
  let tempDbPath: string;
  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const userAddress = '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd' as const;
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';

  beforeEach(() => {
    tempDbPath = path.join(
      process.cwd(),
      `test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new SolverDatabase(tempDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  });

  it('detects user claim from history and triggers EVM claim when WebSocket subscription notification is dropped', async () => {
    const secret =
      '0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff' as const;
    const hashLock = sha256(secret);

    const terms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
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
      userCounterAddress: userAddress,
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac',
      hashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330000,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-test-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
    });

    const orderId = computeOrderId(terms);
    const solverLockTxId = 'f'.repeat(64);

    // Build real claim transaction spending the solver lock
    const bchParams = encodeHtlcParameters(terms);
    const claimTxResult = buildClaimTransaction({
      params: bchParams,
      secret,
      utxo: {
        txid: solverLockTxId,
        vout: 0,
        satoshis: terms.bchCarrySats,
      },
      network: 'chipnet',
    });
    const claimTxId = claimTxResult.txid;
    const claimTxHex = claimTxResult.txHex;

    // Save order in SOLVER_LOCK_SEEN state (waiting for user claim)
    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'SOLVER_LOCK_SEEN',
      terms,
      hashLock,
      userLockTxId: 'e'.repeat(64),
      solverLockTxId,
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 10000,
    });

    // Mock BCH client with DROPPED subscription notifications
    let subscriptionCallback: ((status: string | null) => void) | null = null;
    const mockBchClient = {
      getQuorumStatus: () => ({
        isQuorumHealthy: true,
        quorumTip: 329000,
        tips: { 'wss://node1': 329000 },
        ageSeconds: 60,
        lastConfirmedAt: Date.now(),
        livenessAgeSeconds: 1,
        isLivenessHealthy: true,
      }),
      subscribeScriptHash: vi.fn(
        async (_scriptHash: string, cb?: (status: string | null) => void) => {
          // Record callback but NEVER invoke it (simulating dropped notification!)
          if (cb) subscriptionCallback = cb;
          return null;
        },
      ),
      unsubscribeScriptHash: vi.fn(),
      listUnspent: vi.fn(async () => []),
      // History returns the user claim transaction spending the solver lock
      getHistory: vi.fn(async () => [
        { tx_hash: solverLockTxId, height: 328900 },
        { tx_hash: claimTxId, height: 0 }, // In mempool!
      ]),
      getTransaction: vi.fn(async (txid: string) => {
        if (txid === claimTxId) return claimTxHex;
        return null;
      }),
      broadcast: vi.fn(async () => '0xmock-broadcast'),
    } as unknown as BchQuorumClient;

    let evmClaimCalledWith: { lockId: string; secret: string } | null = null;
    const mockEvmAdapter = {
      address: solverAddress,
      lockId: (sender: string, hLock: string) =>
        `lock-${sender}-${hLock}`.slice(0, 66),
      getLock: vi.fn(async () => ({ status: 'locked' as const })),
      isFinal: vi.fn(async () => true),
      claim: vi.fn(async (lockId: string, s: string) => {
        evmClaimCalledWith = { lockId, secret: s };
        return { chain: 'base', txId: '0xevm-claim-txid' } as TxRef;
      }),
    } as unknown as EvmChainAdapter;

    const engine = new SolverEngine(
      db,
      mockEvmAdapter,
      mockBchClient,
      solverEvmKey,
      sampleWif,
    );

    // Verify subscription callback was not called
    expect(subscriptionCallback).toBeNull();

    // Run reconciliation safety net!
    await engine.reconcileOrders();

    // Check order status advanced to USER_CLAIM_SEEN -> SOLVER_CLAIM_BROADCAST
    const updatedOrder = db.getOrder(orderId);
    expect(updatedOrder).toBeDefined();
    expect(updatedOrder?.status).toBe('SOLVER_CLAIM_BROADCAST');
    expect(updatedOrder?.secret).toBe(secret);
    expect(updatedOrder?.userClaimTxId).toBe(claimTxId);
    expect(updatedOrder?.solverClaimTxId).toBe('0xevm-claim-txid');

    // Verify EVM claim was invoked with extracted secret despite dropped notification
    expect(evmClaimCalledWith).toBeDefined();
    expect(
      (evmClaimCalledWith as { lockId: string; secret: string } | null)?.secret,
    ).toBe(secret);
  });

  it('evm claim path is idempotent when lock is already claimed (NotLocked / race protection)', async () => {
    const secret =
      '0x223344556677889900aabbccddeeff11223344556677889900aabbccddeeff22' as const;
    const hashLock = sha256(secret);

    const terms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: `0x${'cc'.repeat(32)}`,
      bchTokenAmount: 50n,
      counterAmount: 500000n,
      counterChain: 'base',
      counterNetworkId: 84532,
      counterAsset: {
        symbol: 'USDC',
        decimals: 6,
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      counterHtlc: '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641',
      userCounterAddress: userAddress,
      userBchLockingBytecode:
        '0x76a914444444444444444444444444444444444444444488ac',
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode:
        '0x76a9143bc28d6d92d9073fb5e3adf481795eaf446bceed88ac',
      hashLock,
      counterDeadline: Math.floor(Date.now() / 1000) + 86400,
      bchRefundHeight: 330000,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: 'quote-test-2',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
    });

    const orderId = computeOrderId(terms);

    db.saveOrder({
      id: orderId,
      direction: 'COUNTER_TO_BCH',
      status: 'USER_CLAIM_SEEN',
      terms,
      hashLock,
      secret,
      userClaimTxId: 'c'.repeat(64),
      solverLockTxId: 'd'.repeat(64),
      createdAt: Date.now() - 30000,
      updatedAt: Date.now() - 10000,
    });

    const existingClaimTx: TxRef = {
      chain: 'base',
      txId: '0xexisting-claim-onchain',
    };

    // getLock returns claimed (e.g. from concurrent execution)
    const mockEvmAdapter = {
      address: solverAddress,
      lockId: (sender: string, hLock: string) =>
        `lock-${sender}-${hLock}`.slice(0, 66),
      getLock: vi.fn(async () => ({
        status: 'claimed' as const,
        claimTx: existingClaimTx,
      })),
      isFinal: vi.fn(async () => true),
      claim: vi.fn(async () => {
        throw new Error('NotLocked()');
      }),
    } as unknown as EvmChainAdapter;

    const mockBchClient = {
      getQuorumStatus: () => ({
        isQuorumHealthy: true,
        quorumTip: 329000,
        tips: { 'wss://node1': 329000 },
        ageSeconds: 60,
        lastConfirmedAt: Date.now(),
        livenessAgeSeconds: 1,
        isLivenessHealthy: true,
      }),
    } as unknown as BchQuorumClient;

    const engine = new SolverEngine(
      db,
      mockEvmAdapter,
      mockBchClient,
      solverEvmKey,
      sampleWif,
    );

    // Call processOrder - should adopt the existing claim without calling claim or throwing NotLocked
    await engine.step();

    const order = db.getOrder(orderId);
    expect(order?.status).toBe('DONE');
    expect(order?.solverClaimTxId).toBe('0xexisting-claim-onchain');
    expect(mockEvmAdapter.claim).not.toHaveBeenCalled();
  });
});
