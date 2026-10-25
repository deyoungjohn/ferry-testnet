import pino from 'pino';
import {
  deriveHtlcAddresses,
  displayToInternalCategory,
  encodeHtlcParameters,
} from '@ferry/htlc-bch';
import { invariantF, type LockEvent } from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { decodeTransaction } from '@bitauth/libauth';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import { transition } from '../state-machine/transitions.js';
import type { SolverOrderRecord, SolverEvent } from '../state-machine/types.js';
import {
  buildSolverBchLockTx,
  extractSecretFromClaimUnlock,
} from '../bch/lock-builder.js';

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
  private evmUnwatch: (() => void) | null = null;
  private subscribedScriptHashes = new Set<string>();
  private readonly logger: pino.Logger;

  constructor(
    public readonly db: SolverDatabase,
    public readonly evmAdapter: EvmChainAdapter,
    public readonly bchClient: BchQuorumClient,
    public readonly solverPrivateKey: `0x${string}`,
    public readonly solverBchWif?: string,
    logger?: pino.Logger,
  ) {
    this.logger =
      logger ??
      pino({
        level: process.env.LOG_LEVEL || 'info',
        redact: {
          paths: ['secret', 'solverBchWif', 'solverPrivateKey'],
          censor: '[REDACTED]',
        },
      });
  }

  async start(): Promise<void> {
    this.running = true;

    // 1. Startup reconciliation
    await this.reconcileOrders();

    // 2. Wire EVM adapter watcher
    try {
      this.evmUnwatch = this.evmAdapter.watch(async (event) => {
        try {
          await this.handleEvmEvent(event);
        } catch (err) {
          this.logger.error({ err, event }, 'Error handling EVM watcher event');
        }
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to initialize EVM adapter watch');
    }

    // 3. Subscribe to BCH HTLCs for all active orders
    const activeOrders = this.db.listNonTerminalOrders();
    for (const order of activeOrders) {
      await this.ensureBchSubscription(order);
    }

    // 4. Poll / event loop for processing order state transitions
    this.pollInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.step();
      } catch (err) {
        this.logger.error({ err }, 'Error in solver engine loop');
      }
    }, 2000);
  }

  stop(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.evmUnwatch) {
      this.evmUnwatch();
      this.evmUnwatch = null;
    }
    for (const sh of this.subscribedScriptHashes) {
      this.bchClient.unsubscribeScriptHash(sh, () => {});
    }
    this.subscribedScriptHashes.clear();
  }

  async ensureBchSubscription(order: SolverOrderRecord): Promise<string> {
    const terms = order.terms;
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

    const { sha256: lSha256, binToHex } = await import('@bitauth/libauth');
    const shHex = binToHex(lSha256.hash(addresses.lockingBytecode).reverse());

    if (!this.subscribedScriptHashes.has(shHex)) {
      this.subscribedScriptHashes.add(shHex);
      await this.bchClient.subscribeScriptHash(shHex, async () => {
        try {
          await this.handleBchNotification(order, shHex);
        } catch (err) {
          this.logger.error(
            { err, orderId: order.id, scriptHash: shHex },
            'Error handling BCH scripthash notification',
          );
        }
      });
    }

    return shHex;
  }

  async handleEvmEvent(event: LockEvent): Promise<void> {
    if (event.removed) return;

    if (event.type === 'Locked') {
      const order = this.db.getOrderByHashLock(event.lock.hashLock);
      if (!order) return;

      if (order.status === 'QUOTED') {
        this.applyEvent(order, {
          type: 'USER_LOCK_SEEN',
          txId: event.tx.txId,
        });
      }
      const isFinal = await this.evmAdapter.isFinal(event.tx, 'safe');
      if (
        isFinal &&
        (order.status === 'QUOTED' || order.status === 'USER_LOCK_SEEN')
      ) {
        this.applyEvent(order, {
          type: 'USER_LOCK_FINAL',
          txId: event.tx.txId,
        });
      }
    } else if (event.type === 'Claimed') {
      const activeOrders = this.db.listNonTerminalOrders();
      const order = activeOrders.find(
        (o) =>
          this.evmAdapter.lockId(
            o.terms.userCounterAddress as `0x${string}`,
            o.terms.hashLock,
          ) === event.lockId,
      );
      if (!order) return;

      if (
        order.status === 'SOLVER_CLAIM_BROADCAST' ||
        order.status === 'USER_CLAIM_SEEN'
      ) {
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: event.tx.txId,
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
      }
    } else if (event.type === 'Refunded') {
      const activeOrders = this.db.listNonTerminalOrders();
      const order = activeOrders.find(
        (o) =>
          this.evmAdapter.lockId(
            o.terms.userCounterAddress as `0x${string}`,
            o.terms.hashLock,
          ) === event.lockId,
      );
      if (!order) return;

      this.applyEvent(order, {
        type: 'BCH_DEADLINE_PASSED',
        refundTxId: event.tx.txId,
      });
    }
  }

  async handleBchNotification(
    order: SolverOrderRecord,
    scriptHash: string,
  ): Promise<void> {
    const utxos = await this.bchClient.listUnspent(
      scriptHash,
      'include_tokens',
    );
    if (utxos.length > 0) {
      if (order.status === 'SOLVER_LOCK_BROADCAST') {
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_SEEN',
          txId: utxos[0]!.tx_hash,
        });
      }
      return;
    }

    // If no UTXO exists, it was spent or refunded. Inspect history
    const history = await this.bchClient.getHistory(scriptHash);
    if (history.length > 1) {
      // Input 0 was lock tx, input 1 was spend/refund tx
      const spendEntry = history[history.length - 1]!;
      const spendTxHex = (await this.bchClient.getTransaction(
        spendEntry.tx_hash,
        false,
      )) as string;

      if (typeof spendTxHex === 'string') {
        const decoded = decodeTransaction(Buffer.from(spendTxHex, 'hex'));
        if (typeof decoded !== 'string' && decoded.inputs.length > 0) {
          const unlocking = decoded.inputs[0]!.unlockingBytecode;
          const secret = extractSecretFromClaimUnlock(
            unlocking,
            order.hashLock,
          );
          if (secret) {
            this.applyEvent(order, {
              type: 'USER_CLAIM_SEEN',
              txId: spendEntry.tx_hash,
              secret,
            });
            return;
          }
        }
      }

      this.applyEvent(order, {
        type: 'BCH_DEADLINE_PASSED',
        refundTxId: spendEntry.tx_hash,
      });
    }
  }

  async reconcileOrders(): Promise<void> {
    const orders = this.db.listNonTerminalOrders();
    for (const order of orders) {
      try {
        await this.reconcileOrder(order);
      } catch (err) {
        this.logger.error(
          { err, orderId: order.id },
          'Error reconciling order',
        );
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
    if (evmLock.status === 'claimed') {
      // Finding 9: Unexpected combinations land in an explicit needs_attention flag rather than DONE
      if (
        order.status === 'QUOTED' ||
        order.status === 'USER_LOCK_SEEN' ||
        order.status === 'USER_LOCK_FINAL'
      ) {
        this.logger.warn(
          { orderId: order.id, status: order.status },
          'Reconciliation: EVM lock is claimed unexpectedly early; marking needs_attention',
        );
        this.db.markNeedsAttention(
          order.id,
          `Unexpected EVM claim while order was in state ${order.status}`,
        );
        order.needsAttention = true;
        return;
      }

      if (order.status !== 'DONE') {
        if (evmLock.secret && !order.secret) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: order.solverClaimTxId || 'reconciled-claim',
            secret: evmLock.secret,
          });
        }
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: order.solverClaimTxId || 'reconciled-claim',
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
        return;
      }
    } else if (evmLock.status === 'refunded') {
      this.applyEvent(order, {
        type: 'BCH_DEADLINE_PASSED',
        refundTxId: 'reconciled-refund',
      });
      return;
    } else if (evmLock.status === 'locked') {
      if (order.status === 'QUOTED') {
        const lockTxId = order.userLockTxId || 'reconciled-user-lock';
        this.applyEvent(order, {
          type: 'USER_LOCK_SEEN',
          txId: lockTxId,
        });
      }
      if (order.status === 'USER_LOCK_SEEN') {
        const isFinal = await this.evmAdapter.isFinal(
          {
            chain: terms.counterChain,
            txId: order.userLockTxId || 'reconciled-user-lock',
          },
          'safe',
        );
        if (isFinal) {
          this.applyEvent(order, {
            type: 'USER_LOCK_FINAL',
            txId: order.userLockTxId || 'reconciled-user-lock',
          });
        }
      }
    }

    // 2. Check BCH lock state
    try {
      const shHex = await this.ensureBchSubscription(order);
      await this.handleBchNotification(order, shHex);
    } catch (err) {
      this.logger.error(
        { err, orderId: order.id },
        'Error during BCH lock state reconciliation',
      );
    }
  }

  async step(): Promise<void> {
    const orders = this.db.listNonTerminalOrders();
    for (const order of orders) {
      try {
        await this.processOrder(order);
      } catch (err) {
        this.logger.error({ err, orderId: order.id }, 'Error processing order');
      }
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
      const now = Math.floor(Date.now() / 1000);

      // Check quote expiry (CH-03)
      if (now > terms.quoteExpiry) {
        this.logger.warn(
          { orderId: order.id, quoteExpiry: terms.quoteExpiry, now },
          'Quote expired before user lock finalized; refusing to counter-lock',
        );
        this.applyEvent(order, {
          type: 'INVALID_TERMS',
          reason: 'Quote expired before user lock finalized',
        });
        return;
      }

      // Check Invariant F at counter-lock time t0 (CH-04)
      const bchTipHeight = this.bchClient.getQuorumStatus().quorumTip || 329000;
      const timingDecision = invariantF(
        {
          counterDeadline: terms.counterDeadline,
          bchRefundHeight: terms.bchRefundHeight,
        },
        { unixSeconds: now, bchTipHeight },
      );
      if (!timingDecision.allowed) {
        this.logger.warn(
          { orderId: order.id, reason: timingDecision.reason },
          'Invariant F violation at counter-lock time; refusing to counter-lock',
        );
        this.applyEvent(order, {
          type: 'INVALID_TERMS',
          reason: `Invariant F violation at counter-lock: ${timingDecision.reason}`,
        });
        return;
      }

      // Ensure user lock is verified as final on EVM before broadcasting counter-lock
      if (order.userLockTxId) {
        const isFinal = await this.evmAdapter.isFinal(
          { chain: terms.counterChain, txId: order.userLockTxId },
          'safe',
        );
        if (!isFinal) {
          this.logger.debug(
            { orderId: order.id },
            'Waiting for user lock finality before counter-lock',
          );
          return;
        }
      }

      const existingAction = this.db.getAction(order.id, 'SOLVER_LOCK');
      if (!existingAction || existingAction.status === 'PENDING') {
        const startDetect = Date.now();
        this.db.recordActionIntent(order.id, 'SOLVER_LOCK', {
          tokenCategory: terms.bchTokenCategory,
          amount: terms.bchTokenAmount.toString(),
        });

        // Broadcast real solver BCH lock transaction
        const bchTxId = await this.broadcastSolverBchLock(order);
        this.db.recordActionBroadcast(order.id, 'SOLVER_LOCK', bchTxId);

        const latency = Date.now() - startDetect;
        this.metrics.lastReactionTimeMs = latency;
        this.metrics.reactionTimesMs.push(latency);

        this.applyEvent(order, {
          type: 'SOLVER_LOCK_BROADCAST',
          txId: bchTxId,
        });

        // Ensure we watch the new BCH contract
        await this.ensureBchSubscription(order);
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

  async broadcastSolverBchLock(order: SolverOrderRecord): Promise<string> {
    if (this.solverBchWif) {
      this.logger.info(
        { orderId: order.id },
        'Building and broadcasting real BCH lock transaction',
      );
      const built = await buildSolverBchLockTx({
        wif: this.solverBchWif,
        terms: order.terms,
        bchClient: this.bchClient,
      });

      const broadcastTxid = await this.bchClient.broadcast(built.txHex);
      this.logger.info(
        { orderId: order.id, txid: broadcastTxid },
        'Real BCH lock broadcast successfully',
      );
      return broadcastTxid;
    }

    // If no WIF provided (e.g. testing with simulated chain adapter), broadcast simulated tx via bchClient
    const txId =
      order.solverLockTxId ||
      `0x${Buffer.from(`bch-lock-${order.id}-${Date.now()}`).toString('hex')}`;
    await this.bchClient.broadcast(txId);
    return txId;
  }
}
