import { describe, it, expect, beforeEach } from 'vitest';
import { SolverDatabase } from '../src/db/database.js';
import { SolverEngine } from '../src/engine/runner.js';
import { BchQuorumClient } from '../src/bch/quorum-client.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { parseOrderTerms } from '@ferry/core';
import type { ForwardOrderStatus } from '../src/state-machine/types.js';

describe('Chaos & Failure Tests (CH-01, CH-03, CH-04)', () => {
  let db: SolverDatabase;
  const solverEvmKey =
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
  const solverAddress = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

  beforeEach(() => {
    db = new SolverDatabase(':memory:');
  });

  const dummyTerms = parseOrderTerms({
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
    counterDeadline: 1700086400,
    bchRefundHeight: 330000,
    bchCarrySats: 3000n,
    bchMaxFee: 1500n,
    quoteId: 'chaos-quote-1',
    quoteExpiry: 1700000120,
  });

  it('CH-01: SIGKILL in every forward state reconciles upon restart to safe terminal state', async () => {
    const statesToKill: ForwardOrderStatus[] = [
      'QUOTED',
      'USER_LOCK_SEEN',
      'USER_LOCK_FINAL',
      'SOLVER_LOCK_BROADCAST',
      'SOLVER_LOCK_SEEN',
      'SECRET_KNOWN',
      'USER_CLAIM_SEEN',
      'SOLVER_CLAIM_BROADCAST',
      'SOLVER_CLAIM_FINAL',
    ];

    const secret = `0x${'77'.repeat(32)}` as const;

    for (let i = 0; i < statesToKill.length; i++) {
      const state = statesToKill[i]!;
      const orderId = `0x${i.toString(16).padStart(64, '0')}`;

      // Save order in killed state
      db.saveOrder({
        id: orderId,
        direction: 'COUNTER_TO_BCH',
        status: state,
        terms: dummyTerms,
        hashLock: dummyTerms.hashLock,
        secret:
          state === 'SECRET_KNOWN' || state === 'USER_CLAIM_SEEN'
            ? secret
            : undefined,
        secretSource:
          state === 'USER_CLAIM_SEEN'
            ? 'on_chain_claim'
            : state === 'SECRET_KNOWN'
              ? 'cooperative'
              : undefined,
        userLockTxId: '0xuser-lock',
        solverLockTxId: '0xsolver-lock',
        solverClaimTxId: '0xsolver-claim',
        createdAt: Date.now() - 10000,
        updatedAt: Date.now() - 10000,
      });

      // Simulate crash and restart: create fresh engine instance
      const fakeEvm = {
        address: solverAddress,
        lockId: () => dummyTerms.hashLock,
        getLock: async () => ({
          status: 'claimed' as const,
          secret,
        }),
        isFinal: async () => true,
        claim: async () => ({ chain: 'base' as const, txId: '0xnew-claim' }),
      } as unknown as EvmChainAdapter;

      const fakeBch = {
        getQuorumStatus: () => ({
          quorumTip: 330000,
          tips: {},
          isQuorumHealthy: true,
          ageSeconds: 5,
        }),
        listUnspent: async () => [],
      } as unknown as BchQuorumClient;

      const restartEngine = new SolverEngine(
        db,
        fakeEvm,
        fakeBch,
        solverEvmKey,
      );

      // Startup reconciliation
      await restartEngine.reconcileOrders();

      const recovered = db.getOrder(orderId);
      expect(recovered).not.toBeNull();
      // Since chain shows claimed on EVM, order must safely reach DONE terminal state
      expect(recovered!.status).toBe('DONE');
      restartEngine.stop();
    }
  });

  it('CH-03: Reorg handling detects rolled back EVM lock and prevents premature solver lock', async () => {
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

    let evmConfirmations = 0;
    const fakeEvm = {
      address: solverAddress,
      lockId: () => dummyTerms.hashLock,
      getLock: async () => ({
        status: evmConfirmations > 0 ? ('locked' as const) : ('none' as const),
      }),
      isFinal: async () => evmConfirmations >= 10,
    } as unknown as EvmChainAdapter;

    const fakeBch = {
      getQuorumStatus: () => ({
        quorumTip: 330000,
        tips: {},
        isQuorumHealthy: true,
        ageSeconds: 5,
      }),
      listUnspent: async () => [],
    } as unknown as BchQuorumClient;

    const engine = new SolverEngine(db, fakeEvm, fakeBch, solverEvmKey);

    // Initial check: 0 confirmations (reorged out)
    await engine.reconcileOrder(db.getOrder(orderId)!);
    expect(db.getOrder(orderId)!.status).toBe('USER_LOCK_SEEN');

    // Confirmations arrive: reaches safe threshold
    evmConfirmations = 10;
    await engine.reconcileOrder(db.getOrder(orderId)!);
    expect(db.getOrder(orderId)!.status).toBe('USER_LOCK_FINAL');

    engine.stop();
  });

  it('CH-04: BCH disconnect, reconnect and history reconciliation catches missed transactions', async () => {
    let scriptCallbackCalled = false;

    // Create client and register callback
    const client = new BchQuorumClient(['wss://fake-endpoint']);
    await client.subscribeScriptHash('76a914test', () => {
      scriptCallbackCalled = true;
    });

    // Mock getHistory returning new tx
    client.getHistory = async () => [
      { height: 330005, tx_hash: '0xmissed-bch-tx-during-disconnect' },
    ];

    // Trigger reconciliation (as happens on reconnect)
    await client.reconcileScriptHash('76a914test');
    expect(scriptCallbackCalled).toBe(true);

    client.close();
  });
});
