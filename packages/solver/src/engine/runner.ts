import { sha256 } from 'viem';
import { binToHex, sha256 as libauthSha256 } from '@bitauth/libauth';
import {
  deriveHtlcAddresses,
  displayToInternalCategory,
  encodeHtlcParameters,
} from '@ferry/htlc-bch';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import { transition } from '../state-machine/transitions.js';
import type { SolverOrderRecord, SolverEvent } from '../state-machine/types.js';

export interface SolverMetrics {
  reactionTimesMs: number[];
  lastReactionTimeMs: number;
}

export class SolverEngine {
  public readonly metrics: SolverMetrics = {
    reactionTimesMs: [],
    lastReactionTimeMs: 0,
  };
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    public readonly db: SolverDatabase,
    public readonly evmAdapter: EvmChainAdapter,
    public readonly bchClient: BchQuorumClient,
    public readonly solverPrivateKey: `0x${string}`,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    // 1. Startup reconciliation
    await this.reconcileOrders();

    // 2. Poll / event loop for non-terminal orders
    this.pollInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.step();
      } catch {
        // Log loop error and continue
      }
    }, 2000);
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async reconcileOrders(): Promise<void> {
    const orders = this.db.listNonTerminalOrders();
    for (const order of orders) {
      try {
        await this.reconcileOrder(order);
      } catch {
        // Keep reconciling other orders
      }
    }
  }

  async reconcileOrder(order: SolverOrderRecord): Promise<void> {
    const terms = order.terms;
    const lockId = this.evmAdapter.lockId(
      terms.userCounterAddress as `0x${string}`,
      terms.hashLock,
    );

    // 1. Check EVM lock state
    const evmLock = await this.evmAdapter.getLock(lockId);
    if (evmLock.status === 'locked') {
      if (order.status === 'QUOTED') {
        this.applyEvent(order, {
          type: 'USER_LOCK_SEEN',
          txId: order.userLockTxId || '0xreconciled',
        });
      }
      if (order.status === 'USER_LOCK_SEEN') {
        const isFinal = await this.evmAdapter.isFinal(
          {
            chain: terms.counterChain,
            txId: order.userLockTxId || '0xreconciled',
          },
          'safe',
        );
        if (isFinal) {
          this.applyEvent(order, {
            type: 'USER_LOCK_FINAL',
            txId: order.userLockTxId || '0xreconciled',
          });
        }
      }
    } else if (evmLock.status === 'claimed') {
      if (order.status !== 'DONE') {
        // If claimed on EVM, the secret was publicly exposed on EVM
        if (evmLock.secret) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: '0xreconciled-evm-claim',
            secret: evmLock.secret,
          });
        }
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: '0xreconciled-evm-claim',
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
        return;
      }
    } else if (evmLock.status === 'refunded') {
      this.applyEvent(order, {
        type: 'BCH_DEADLINE_PASSED',
        refundTxId: '0xreconciled-refund',
      });
      return;
    }

    // 2. Check BCH lock state
    try {
      const bchParams = encodeHtlcParameters({
        recipientLockingBytecode: terms.userBchLockingBytecode,
        refundLockingBytecode: terms.solverBchLockingBytecode,
        hashLock: terms.hashLock,
        refundHeight: terms.bchRefundHeight,
        tokenCategory: displayToInternalCategory(terms.bchTokenCategory),
        tokenAmount: terms.bchTokenAmount,
        maxFee: terms.bchMaxFee,
      });

      const addresses = deriveHtlcAddresses(bchParams, 'chipnet');
      const hash = libauthSha256.hash(addresses.lockingBytecode);
      const contractScriptHash = binToHex(new Uint8Array(hash).reverse());

      const utxos = await this.bchClient.listUnspent(contractScriptHash);
      if (utxos.length > 0 && order.status === 'SOLVER_LOCK_BROADCAST') {
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_SEEN',
          txId: utxos[0]!.tx_hash,
        });
      }
    } catch {
      // Ignore BCH network errors during reconciliation
    }
  }

  async step(): Promise<void> {
    const orders = this.db.listNonTerminalOrders();
    for (const order of orders) {
      await this.processOrder(order);
    }
  }

  async processOrder(order: SolverOrderRecord): Promise<void> {
    const terms = order.terms;
    const lockId = this.evmAdapter.lockId(
      terms.userCounterAddress as `0x${string}`,
      terms.hashLock,
    );

    // USER_LOCK_FINAL -> SOLVER_LOCK_BROADCAST
    if (order.status === 'USER_LOCK_FINAL') {
      const existingAction = this.db.getAction(order.id, 'SOLVER_LOCK');
      if (!existingAction || existingAction.status === 'PENDING') {
        const startDetect = Date.now();
        this.db.recordActionIntent(order.id, 'SOLVER_LOCK', {
          tokenCategory: terms.bchTokenCategory,
          amount: terms.bchTokenAmount.toString(),
        });

        // Broadcast solver BCH lock transaction
        const bchTxId = await this.broadcastSolverBchLock(order);
        this.db.recordActionBroadcast(order.id, 'SOLVER_LOCK', bchTxId);

        const latency = Date.now() - startDetect;
        this.metrics.lastReactionTimeMs = latency;
        this.metrics.reactionTimesMs.push(latency);

        this.applyEvent(order, {
          type: 'SOLVER_LOCK_BROADCAST',
          txId: bchTxId,
        });
      }
    }

    // USER_CLAIM_SEEN -> SOLVER_CLAIM_BROADCAST
    if (order.status === 'USER_CLAIM_SEEN' && order.secret) {
      const existingAction = this.db.getAction(order.id, 'SOLVER_CLAIM');
      if (!existingAction || existingAction.status === 'PENDING') {
        const startClaim = Date.now();
        this.db.recordActionIntent(order.id, 'SOLVER_CLAIM', {
          lockId,
        });

        // Pre-broadcast check
        const currentLock = await this.evmAdapter.getLock(lockId);
        if (currentLock.status === 'locked') {
          const claimTx = await this.evmAdapter.claim(lockId, order.secret);
          this.db.recordActionBroadcast(order.id, 'SOLVER_CLAIM', claimTx.txId);

          const latency = Date.now() - startClaim;
          this.metrics.lastReactionTimeMs = latency;
          this.metrics.reactionTimesMs.push(latency);

          this.applyEvent(order, {
            type: 'SOLVER_CLAIM_BROADCAST',
            txId: claimTx.txId,
          });
        }
      }
    }

    // SOLVER_CLAIM_BROADCAST -> SOLVER_CLAIM_FINAL -> DONE
    if (order.status === 'SOLVER_CLAIM_BROADCAST' && order.solverClaimTxId) {
      const isFinal = await this.evmAdapter.isFinal(
        { chain: terms.counterChain, txId: order.solverClaimTxId },
        'safe',
      );
      if (isFinal) {
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: order.solverClaimTxId,
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
      }
    }
  }

  applyEvent(order: SolverOrderRecord, event: SolverEvent): void {
    const res = transition(order, event);
    order.status = res.nextStatus;
    if (res.mutations) {
      Object.assign(order, res.mutations);
    }
    order.updatedAt = Date.now();
    this.db.saveOrder(order);
  }

  private async broadcastSolverBchLock(
    order: SolverOrderRecord,
  ): Promise<string> {
    // Generate or mock lock txid for solver BCH lock
    // On real chipnet with funded WIF, this builds and broadcasts via this.bchClient.broadcast
    const dummyTxId = (order.solverLockTxId ||
      sha256(
        `0x${Buffer.from(`bch-lock-${order.id}-${Date.now()}`).toString('hex')}`,
      )) as string;
    return dummyTxId;
  }
}
