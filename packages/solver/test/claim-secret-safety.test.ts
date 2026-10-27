import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { sha256 } from 'viem';
import {
  parseOrderTerms,
  orderId as computeOrderId,
  isValidSecret,
  assertValidSecret,
  type TxRef,
} from '@ferry/core';
import {
  encodeHtlcParameters,
  buildClaimTransaction,
  buildRefundTransaction,
  verifyClaimTransactionHex,
  verifyRefundTransactionHex,
} from '@ferry/htlc-bch';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { transition } from '../src/state-machine/transitions.js';
import type { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';

describe('Claim Secret Safety & Action Rebuild', () => {
  let db: SolverDatabase;
  let tempDbPath: string;

  const validSecret =
    '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as const;
  const zeroSecret =
    '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
  const hashLock = sha256(validSecret);

  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;
  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const userAddress = '0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd' as const;
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';

  beforeEach(() => {
    tempDbPath = path.join(
      process.cwd(),
      `test-safety-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = new SolverDatabase(tempDbPath);
  });

  afterEach(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    if (fs.existsSync(`${tempDbPath}-wal`)) fs.unlinkSync(`${tempDbPath}-wal`);
    if (fs.existsSync(`${tempDbPath}-shm`)) fs.unlinkSync(`${tempDbPath}-shm`);
  });

  function createTestTerms(
    direction: 'BCH_TO_COUNTER' | 'COUNTER_TO_BCH' = 'BCH_TO_COUNTER',
  ) {
    return parseOrderTerms({
      version: 1,
      direction,
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
      quoteId: 'quote-safety-1',
      quoteExpiry: Math.floor(Date.now() / 1000) + 300,
    });
  }

  describe('1. Secret Validation at DB and State Machine boundaries', () => {
    it('isValidSecret accurately validates preimage match', () => {
      expect(isValidSecret(validSecret, hashLock)).toBe(true);
      expect(isValidSecret(zeroSecret, hashLock)).toBe(false);
      expect(isValidSecret('0xinvalid', hashLock)).toBe(false);
      expect(isValidSecret(null, hashLock)).toBe(false);
      expect(isValidSecret(undefined, hashLock)).toBe(false);
    });

    it('assertValidSecret throws on mismatch or invalid format', () => {
      expect(() => assertValidSecret(validSecret, hashLock)).not.toThrow();
      expect(() => assertValidSecret(zeroSecret, hashLock)).toThrow(
        /does not match expected hashLock/,
      );
      expect(() => assertValidSecret('0x12', hashLock)).toThrow(
        /Invalid secret/,
      );
    });

    it('db.saveOrder rejects orders with an invalid secret (e.g. 32 zero bytes)', () => {
      const terms = createTestTerms();
      const orderId = computeOrderId(terms);

      // Attempting to save order with zeroSecret must throw
      expect(() => {
        db.saveOrder({
          id: orderId,
          direction: 'BCH_TO_COUNTER',
          status: 'USER_CLAIM_SEEN',
          terms,
          hashLock,
          secret: zeroSecret,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }).toThrow(/does not match expected hashLock/);

      // Saving with null secret succeeds
      expect(() => {
        db.saveOrder({
          id: orderId,
          direction: 'BCH_TO_COUNTER',
          status: 'USER_CLAIM_SEEN',
          terms,
          hashLock,
          secret: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }).not.toThrow();

      // Saving with validSecret succeeds
      expect(() => {
        db.saveOrder({
          id: orderId,
          direction: 'BCH_TO_COUNTER',
          status: 'USER_CLAIM_SEEN',
          terms,
          hashLock,
          secret: validSecret,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }).not.toThrow();
    });

    it('transition rejects USER_CLAIM_SEEN with invalid secret', () => {
      const terms = createTestTerms();
      const order = {
        id: computeOrderId(terms),
        direction: 'BCH_TO_COUNTER' as const,
        status: 'SOLVER_LOCK_SEEN' as const,
        terms,
        hashLock,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      expect(() => {
        transition(order, {
          type: 'USER_CLAIM_SEEN',
          txId: '0xabc',
          secret: zeroSecret,
        });
      }).toThrow(/does not match expected hashLock/);
    });

    it('transition allows USER_CLAIM_SEEN without secret, then updates secret when valid secret arrives', () => {
      const terms = createTestTerms();
      const order = {
        id: computeOrderId(terms),
        direction: 'BCH_TO_COUNTER' as const,
        status: 'SOLVER_LOCK_SEEN' as const,
        terms,
        hashLock,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      // 1. Initial USER_CLAIM_SEEN when secret is not yet readable (null/undefined)
      const res1 = transition(order, {
        type: 'USER_CLAIM_SEEN',
        txId: '0xclaim1',
        secret: undefined,
      });
      expect(res1.nextStatus).toBe('USER_CLAIM_SEEN');
      expect(res1.mutations?.secret).toBeUndefined();

      // Apply mutation
      Object.assign(order, res1.mutations, { status: res1.nextStatus });

      // 2. Later, true secret arrives
      const res2 = transition(order, {
        type: 'USER_CLAIM_SEEN',
        txId: '0xclaim1',
        secret: validSecret,
      });
      expect(res2.nextStatus).toBe('USER_CLAIM_SEEN');
      expect(res2.mutations?.secret).toBe(validSecret);
      expect(res2.mutations?.secretSource).toBe('on_chain_claim');
    });
  });

  describe('2. BCH Script VM Spend Verification', () => {
    it('buildClaimTransaction throws with script VM error when given invalid secret', () => {
      const terms = createTestTerms();
      const bchParams = encodeHtlcParameters(terms);

      expect(() => {
        buildClaimTransaction({
          params: bchParams,
          secret: zeroSecret,
          utxo: {
            txid: '1'.repeat(64),
            vout: 0,
            satoshis: terms.bchCarrySats,
          },
          network: 'chipnet',
          verifyWithVm: true,
        });
      }).toThrow(/VM verification failed.*OP_VERIFY/);
    });

    it('verifyClaimTransactionHex detects bad spend and confirms valid spend', () => {
      const terms = createTestTerms();
      const bchParams = encodeHtlcParameters(terms);
      const utxo = {
        txid: '1'.repeat(64),
        vout: 0,
        satoshis: terms.bchCarrySats,
      };

      // 1. Build valid claim tx
      const validTx = buildClaimTransaction({
        params: bchParams,
        secret: validSecret,
        utxo,
        network: 'chipnet',
      });

      // Verification succeeds
      const checkValid = verifyClaimTransactionHex({
        params: bchParams,
        utxo,
        txHex: validTx.txHex,
        network: 'chipnet',
      });
      expect(checkValid).toBe(true);

      // 2. Build claim tx with invalid secret (without verifyWithVm) to simulate stored bad action
      const badTx = buildClaimTransaction({
        params: bchParams,
        secret: zeroSecret,
        utxo,
        network: 'chipnet',
      });

      // Verification fails
      const checkBad = verifyClaimTransactionHex({
        params: bchParams,
        utxo,
        txHex: badTx.txHex,
        network: 'chipnet',
      });
      expect(typeof checkBad).toBe('string');
      expect(checkBad).toContain('OP_VERIFY');
    });

    it('verifyRefundTransactionHex verifies valid refund transaction', () => {
      const terms = createTestTerms();
      const bchParams = encodeHtlcParameters(terms);
      const utxo = {
        txid: '2'.repeat(64),
        vout: 0,
        satoshis: terms.bchCarrySats,
      };

      const refundTx = buildRefundTransaction({
        params: bchParams,
        utxo,
        network: 'chipnet',
        verifyWithVm: true,
      });

      const check = verifyRefundTransactionHex({
        params: bchParams,
        utxo,
        txHex: refundTx.txHex,
        network: 'chipnet',
      });
      expect(check).toBe(true);
    });
  });

  describe('3. Action verification and rebuild in executeOrAdoptBchTx', () => {
    it('deletes stored action and rebuilds if stored txHex fails script VM verification', async () => {
      const terms = createTestTerms();
      const orderId = computeOrderId(terms);
      const userLockTxId = '3'.repeat(64);

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_CLAIM_SEEN',
        terms,
        hashLock,
        secret: validSecret,
        userLockTxId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Pre-seed an invalid action in the DB (like where bad tx was stored)
      const badTxHex =
        '010000000100000000000000000000000000000000000000000000000000000000000000000000000000ffffffff0100000000000000000000000000';
      db.recordActionIntent(orderId, 'SOLVER_CLAIM', {
        txid: 'badtxid',
        txHex: badTxHex,
      });

      const mockBchClient = {
        broadcast: vi.fn().mockResolvedValue('goodtxid'),
        getHistory: vi.fn().mockResolvedValue([]),
        getTransaction: vi.fn().mockRejectedValue(new Error('not found')),
      } as unknown as BchQuorumClient;

      const mockEvmAdapter = {
        lockId: vi.fn().mockReturnValue('0xlock'),
        getLock: vi.fn(),
      } as unknown as EvmChainAdapter;

      const engine = new SolverEngine(
        db,
        mockEvmAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      let buildCount = 0;
      const result = await engine.executeOrAdoptBchTx({
        orderId,
        actionType: 'SOLVER_CLAIM',
        buildTx: async () => {
          buildCount++;
          return { txid: 'goodtxid', txHex: '02000000...' };
        },
        verifyTx: (txHex) => {
          if (txHex === badTxHex) return 'VM script verification failed';
          return true;
        },
        isOnChain: async () => false,
      });

      expect(buildCount).toBe(1);
      expect(result.txid).toBe('goodtxid');
      expect(mockBchClient.broadcast).toHaveBeenCalledWith('02000000...');

      // The action in DB should now have goodtxid
      const action = db.getAction(orderId, 'SOLVER_CLAIM');
      expect(action?.status).toBe('BROADCAST');
      expect(action?.txId).toBe('goodtxid');
    });

    it('deletes stored action and rebuilds if broadcast is stale and not in mempool/chain', async () => {
      const terms = createTestTerms();
      const orderId = computeOrderId(terms);

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_CLAIM_SEEN',
        terms,
        hashLock,
        secret: validSecret,
        createdAt: Date.now() - 400000,
        updatedAt: Date.now() - 400000,
      });

      // Stored action that was broadcast 5 minutes ago
      db.recordActionIntent(orderId, 'SOLVER_CLAIM', {
        txid: 'droppedtxid',
        txHex: '01000000...',
      });
      db.recordActionBroadcast(orderId, 'SOLVER_CLAIM', 'droppedtxid');

      // Artificially age the action
      db.db
        .prepare('UPDATE actions SET updated_at = ? WHERE order_id = ?')
        .run(Date.now() - 5 * 60 * 1000, orderId);

      const mockBchClient = {
        broadcast: vi.fn().mockResolvedValue('freshbuilt'),
        getHistory: vi.fn().mockResolvedValue([]),
        getTransaction: vi
          .fn()
          .mockRejectedValue(new Error('not found in mempool')),
      } as unknown as BchQuorumClient;

      const engine = new SolverEngine(
        db,
        {} as EvmChainAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      let rebuildCalled = false;
      const result = await engine.executeOrAdoptBchTx({
        orderId,
        actionType: 'SOLVER_CLAIM',
        buildTx: async () => {
          rebuildCalled = true;
          return { txid: 'freshbuilt', txHex: '020000fresh...' };
        },
        verifyTx: () => true,
        isOnChain: async () => false,
      });

      expect(rebuildCalled).toBe(true);
      expect(result.txid).toBe('freshbuilt');
      expect(mockBchClient.broadcast).toHaveBeenCalledWith('020000fresh...');
    });

    it('does NOT record action as BROADCAST if node rejects broadcast, sets needs_attention = 1, and deletes bad action', async () => {
      const terms = createTestTerms();
      const orderId = computeOrderId(terms);

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'USER_CLAIM_SEEN',
        terms,
        hashLock,
        secret: validSecret,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const mockBchClient = {
        broadcast: vi
          .fn()
          .mockRejectedValue(
            new Error(
              '16: mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation)',
            ),
          ),
      } as unknown as BchQuorumClient;

      const engine = new SolverEngine(
        db,
        {} as EvmChainAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await expect(
        engine.executeOrAdoptBchTx({
          orderId,
          actionType: 'SOLVER_CLAIM',
          buildTx: async () => ({ txid: 'badtxid', txHex: 'badbytes' }),
          isOnChain: async () => false,
        }),
      ).rejects.toThrow(/mandatory-script-verify-flag-failed/);

      // Check DB: action must NOT be BROADCAST and must be cleaned up
      const action = db.getAction(orderId, 'SOLVER_CLAIM');
      expect(action).toBeNull();

      // Order must have needsAttention = 1 and rejectionReason set
      const order = db.getOrder(orderId);
      expect(order?.needsAttention).toBe(true);
      expect(order?.rejectionReason).toContain('Node rejected broadcast');
    });
  });

  describe('4. Regression Test for an earlier issue Race Condition', () => {
    it('watcher sees claimed EVM lock before log indexing: waits for real secret and claims correctly without 0s', async () => {
      const terms = createTestTerms('BCH_TO_COUNTER');
      const orderId = computeOrderId(terms);
      const userUtxoTxId = '4'.repeat(64);

      // Order is in SOLVER_LOCK_SEEN
      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'SOLVER_LOCK_SEEN',
        terms,
        hashLock,
        userLockTxId: userUtxoTxId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const simulatedLockState: {
        status: 'claimed';
        claimTx: TxRef;
        secret: `0x${string}` | null;
      } = {
        status: 'claimed',
        claimTx: { chain: 'base', txId: '0xevmclaimtx' },
        secret: null, // Log indexing delayed! Returns null, NOT 32 zero bytes!
      };

      const mockEvmAdapter = {
        lockId: vi.fn().mockReturnValue('0xevmlockid'),
        getLock: vi.fn().mockImplementation(async () => ({
          ...simulatedLockState,
          owner: terms.solverCounterAddress,
          recipient: terms.userCounterAddress,
          asset: terms.counterAsset,
          amount: terms.counterAmount,
          hashLock: terms.hashLock,
          deadline: terms.counterDeadline,
        })),
        watch: vi.fn(),
      } as unknown as EvmChainAdapter;

      const broadcastSpy = vi.fn().mockResolvedValue('bchclaimtxid');
      const mockBchClient = {
        listUnspent: vi.fn().mockResolvedValue([
          {
            tx_hash: userUtxoTxId,
            tx_pos: 0,
            value: Number(terms.bchCarrySats),
            token_data: {
              category: terms.bchTokenCategory.slice(2),
              amount: terms.bchTokenAmount.toString(),
            },
          },
        ]),
        getHistory: vi.fn().mockResolvedValue([]),
        getTransaction: vi.fn().mockRejectedValue(new Error('not found')),
        getQuorumStatus: vi.fn().mockReturnValue({
          isQuorumHealthy: true,
          quorumTip: 330000,
        }),
        broadcast: broadcastSpy,
      } as unknown as BchQuorumClient;

      const engine = new SolverEngine(
        db,
        mockEvmAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      // 1. Runner tick fires while secret is null (not indexed yet)
      const orderBefore = db.getOrder(orderId)!;
      await engine.reconcileOrder(orderBefore);

      // Order transitioned to USER_CLAIM_SEEN, but secret is NOT set to zeros!
      const orderAfterTick1 = db.getOrder(orderId)!;
      expect(orderAfterTick1.status).toBe('USER_CLAIM_SEEN');
      expect(orderAfterTick1.secret).toBeUndefined();
      expect(broadcastSpy).not.toHaveBeenCalled(); // Cannot claim without secret!

      // 2. User calls relay-claim (or watcher later indexes log) with true secret
      simulatedLockState.secret = validSecret;

      // Relay-claim dispatches USER_CLAIM_SEEN with the true secret
      engine.applyEvent(orderAfterTick1, {
        type: 'USER_CLAIM_SEEN',
        txId: '0xevmclaimtx',
        secret: validSecret,
      });

      const orderAfterRelay = db.getOrder(orderId)!;
      expect(orderAfterRelay.secret).toBe(validSecret);

      // 3. Runner proceeds to process BCH claim
      await engine.processSolverBchClaim(orderAfterRelay);

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const broadcastTxHex = broadcastSpy.mock.calls[0]![0];

      // Verify broadcast bytes actually spend with the real secret
      const bchParams = encodeHtlcParameters(terms);
      const verifyResult = verifyClaimTransactionHex({
        params: bchParams,
        utxo: {
          txid: userUtxoTxId,
          vout: 0,
          satoshis: terms.bchCarrySats,
        },
        txHex: broadcastTxHex,
        network: 'chipnet',
      });
      expect(verifyResult).toBe(true);

      const finalOrder = db.getOrder(orderId)!;
      expect(finalOrder.status).toBe('SOLVER_CLAIM_BROADCAST');
    });
  });

  describe('5. Startup self-heal pass for dropped broadcasts', () => {
    it('resets dropped reverse SOLVER_CLAIM_BROADCAST to USER_CLAIM_SEEN and clears action', async () => {
      const terms = createTestTerms('BCH_TO_COUNTER');
      const orderId = computeOrderId(terms);
      const userUtxoTxId = '5'.repeat(64);

      db.saveOrder({
        id: orderId,
        direction: 'BCH_TO_COUNTER',
        status: 'SOLVER_CLAIM_BROADCAST',
        terms,
        hashLock,
        secret: validSecret,
        userLockTxId: userUtxoTxId,
        solverClaimTxId: 'droppedclaimtxid',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      db.recordActionBroadcast(orderId, 'SOLVER_CLAIM', 'droppedclaimtxid');

      const mockBchClient = {
        getHistory: vi.fn().mockResolvedValue([]), // neither in mempool nor in block!
        getTransaction: vi
          .fn()
          .mockRejectedValue(new Error('Transaction not found')),
      } as unknown as BchQuorumClient;

      const mockEvmAdapter = {
        lockId: vi.fn().mockReturnValue('0xevmlock'),
      } as unknown as EvmChainAdapter;

      const engine = new SolverEngine(
        db,
        mockEvmAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.selfHealBroadcastOrders();

      const healedOrder = db.getOrder(orderId)!;
      expect(healedOrder.status).toBe('USER_CLAIM_SEEN');
      expect(healedOrder.solverClaimTxId).toBeUndefined();

      const action = db.getAction(orderId, 'SOLVER_CLAIM');
      expect(action).toBeNull();
    });

    it('resets dropped forward SOLVER_LOCK_BROADCAST to USER_LOCK_FINAL and clears action', async () => {
      const terms = createTestTerms('COUNTER_TO_BCH');
      const orderId = computeOrderId(terms);

      db.saveOrder({
        id: orderId,
        direction: 'COUNTER_TO_BCH',
        status: 'SOLVER_LOCK_BROADCAST',
        terms,
        hashLock,
        solverLockTxId: 'droppedbchlocktxid',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      db.recordActionBroadcast(orderId, 'SOLVER_LOCK', 'droppedbchlocktxid');

      const mockBchClient = {
        getHistory: vi.fn().mockResolvedValue([]),
        getTransaction: vi
          .fn()
          .mockRejectedValue(new Error('Transaction not found')),
        listUnspent: vi.fn().mockResolvedValue([]),
      } as unknown as BchQuorumClient;

      const mockEvmAdapter = {
        lockId: vi.fn().mockReturnValue('0xevmlock'),
      } as unknown as EvmChainAdapter;

      const engine = new SolverEngine(
        db,
        mockEvmAdapter,
        mockBchClient,
        solverEvmKey,
        sampleWif,
        'testnet',
      );

      await engine.selfHealBroadcastOrders();

      const healedOrder = db.getOrder(orderId)!;
      expect(healedOrder.status).toBe('USER_LOCK_FINAL');
      expect(healedOrder.solverLockTxId).toBeUndefined();

      const action = db.getAction(orderId, 'SOLVER_LOCK');
      expect(action).toBeNull();
    });
  });
});
