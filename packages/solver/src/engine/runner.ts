import pino from 'pino';
import {
  deriveHtlcAddresses,
  displayToInternalCategory,
  encodeHtlcParameters,
  buildLockTransaction,
  buildRefundTransaction,
} from '@ferry/htlc-bch';
import { invariantF, type LockEvent } from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { decodeTransaction } from '@bitauth/libauth';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import { transition } from '../state-machine/transitions.js';
import type { SolverOrderRecord, SolverEvent } from '../state-machine/types.js';
import {
  deriveBchKeyDetails,
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
    public readonly solverBchWif: string,
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
      const order = this.db.getOrderByLockId(event.lockId);
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
      const order = this.db.getOrderByLockId(event.lockId);
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
      const order = this.db.getOrderByLockId(event.lockId);
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

    // 1. Check if solver lock is seen
    if (order.status === 'SOLVER_LOCK_BROADCAST' && order.solverLockTxId) {
      const hasUtxo = utxos.some((u) => u.tx_hash === order.solverLockTxId);
      if (hasUtxo) {
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_SEEN',
          txId: order.solverLockTxId,
        });
      }
    }

    // 2. Check if user claimed the lock (spent UTXO revealing secret in unlocking script)
    if (
      order.status === 'SOLVER_LOCK_SEEN' ||
      order.status === 'SOLVER_LOCK_BROADCAST' ||
      order.status === 'SECRET_KNOWN'
    ) {
      const history = await this.bchClient.getHistory(scriptHash);
      if (history.length >= 2) {
        // Find spend transaction (different from solver lock)
        const spendEntry = history.find(
          (h) => h.tx_hash !== order.solverLockTxId,
        );
        if (spendEntry) {
          const rawSpend = await this.bchClient.getTransaction(
            spendEntry.tx_hash,
          );
          const rawHex =
            typeof rawSpend === 'string'
              ? rawSpend
              : (rawSpend as { hex?: string })?.hex;
          if (rawHex) {
            const decoded = decodeTransaction(Buffer.from(rawHex, 'hex'));
            if (typeof decoded !== 'string') {
              for (const input of decoded.inputs) {
                const secret = extractSecretFromClaimUnlock(
                  input.unlockingBytecode,
                  order.terms.hashLock,
                );
                if (secret) {
                  this.applyEvent(order, {
                    type: 'USER_CLAIM_SEEN',
                    txId: spendEntry.tx_hash,
                    secret,
                  });
                  break;
                }
              }
            }
          }
        }
      }
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
    const lockId = this.evmAdapter.lockId(
      order.terms.userCounterAddress as `0x${string}`,
      order.terms.hashLock,
    );
    const evmLock = await this.evmAdapter.getLock(lockId);

    // EVM Lock state reconciliation
    if (evmLock.status === 'locked') {
      const isFinal = evmLock.lockTx
        ? await this.evmAdapter.isFinal(evmLock.lockTx, 'safe')
        : true;
      if (
        isFinal &&
        (order.status === 'QUOTED' || order.status === 'USER_LOCK_SEEN')
      ) {
        this.applyEvent(order, {
          type: 'USER_LOCK_FINAL',
          txId: evmLock.lockTx?.txId || order.userLockTxId || '',
        });
      } else if (order.status === 'QUOTED') {
        this.applyEvent(order, {
          type: 'USER_LOCK_SEEN',
          txId: evmLock.lockTx?.txId || order.userLockTxId || '',
        });
      }
    } else if (evmLock.status === 'claimed') {
      if (order.status === 'SOLVER_CLAIM_BROADCAST') {
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: evmLock.claimTx.txId,
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
      } else if (order.status !== 'DONE') {
        this.logger.warn(
          { orderId: order.id, status: order.status },
          'Reconciliation: EVM lock is claimed unexpectedly early; marking needs_attention',
        );
        this.db.markNeedsAttention(
          order.id,
          'EVM lock claimed in unexpected order state',
        );
      }
    } else if (evmLock.status === 'refunded') {
      this.applyEvent(order, {
        type: 'BCH_DEADLINE_PASSED',
        refundTxId: evmLock.refundTx.txId,
      });
    }

    // BCH lock state reconciliation
    if (order.status !== 'DONE' && order.status !== 'REJECTED') {
      const shHex = await this.ensureBchSubscription(order);
      await this.handleBchNotification(order, shHex);
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
      const quorum = this.bchClient.getQuorumStatus();
      if (
        !quorum.isQuorumHealthy ||
        !quorum.quorumTip ||
        quorum.quorumTip <= 0
      ) {
        this.logger.warn(
          { orderId: order.id, quorum },
          'BCH quorum unhealthy or tip unknown at counter-lock time; delaying counter-lock',
        );
        return;
      }

      const bchTipHeight = quorum.quorumTip;
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

      // CRASH RECOVERY & PRE-BROADCAST WRITE-AHEAD:
      // Build tx first, compute txid and txHex, persist with intent BEFORE broadcasting.
      // On restart, check chain (transaction.get / HTLC UTXOs) and either adopt existing tx or rebroadcast the SAME hex.
      const existingAction = this.db.getAction(order.id, 'SOLVER_LOCK');
      if (existingAction) {
        let intent: { txid: string; txHex: string };
        try {
          intent = JSON.parse(existingAction.intentPayload);
        } catch {
          intent = { txid: existingAction.txId || '', txHex: '' };
        }

        if (intent.txid) {
          // Check if already on chain or in mempool
          const shHex = await this.ensureBchSubscription(order);
          const utxos = await this.bchClient.listUnspent(
            shHex,
            'include_tokens',
          );
          const isMinedOrSeen = utxos.some((u) => u.tx_hash === intent.txid);

          if (!isMinedOrSeen && intent.txHex) {
            try {
              await this.bchClient.broadcast(intent.txHex);
            } catch (err: unknown) {
              this.logger.debug(
                { err, txid: intent.txid },
                'Rebroadcast returned error (may already be in mempool)',
              );
            }
          }

          this.db.recordActionBroadcast(order.id, 'SOLVER_LOCK', intent.txid);
          this.applyEvent(order, {
            type: 'SOLVER_LOCK_BROADCAST',
            txId: intent.txid,
          });
          await this.ensureBchSubscription(order);
          return;
        }
      }

      // If no existing action, build the transaction first
      const startDetect = Date.now();
      const built = await this.buildSolverBchLock(order);

      // Persist {txid, txHex} with intent BEFORE broadcasting
      this.db.recordActionIntent(order.id, 'SOLVER_LOCK', {
        txid: built.txid,
        txHex: built.txHex,
      });

      // Named fault injection hook: crash before broadcast
      if (process.env.FAULT_CRASH_POINT === 'BEFORE_BCH_LOCK_BROADCAST') {
        this.logger.warn(
          { orderId: order.id },
          'Injected fault: BEFORE_BCH_LOCK_BROADCAST',
        );
        process.kill(process.pid, 'SIGKILL');
      }

      // Broadcast real solver BCH lock transaction
      await this.bchClient.broadcast(built.txHex);

      // Named fault injection hook: crash after broadcast
      if (process.env.FAULT_CRASH_POINT === 'AFTER_BCH_LOCK_BROADCAST') {
        this.logger.warn(
          { orderId: order.id },
          'Injected fault: AFTER_BCH_LOCK_BROADCAST',
        );
        process.kill(process.pid, 'SIGKILL');
      }

      this.db.recordActionBroadcast(order.id, 'SOLVER_LOCK', built.txid);

      const latency = Date.now() - startDetect;
      this.metrics.lastReactionTimeMs = latency;
      this.metrics.reactionTimesMs.push(latency);

      this.applyEvent(order, {
        type: 'SOLVER_LOCK_BROADCAST',
        txId: built.txid,
      });

      await this.ensureBchSubscription(order);
    }

    // USER_CLAIM_SEEN -> SOLVER_CLAIM_BROADCAST
    if (order.status === 'USER_CLAIM_SEEN' && order.secret) {
      const existingAction = this.db.getAction(order.id, 'SOLVER_CLAIM');
      if (!existingAction || existingAction.status === 'PENDING') {
        const startClaim = Date.now();
        this.db.recordActionIntent(order.id, 'SOLVER_CLAIM', {
          lockId,
        });

        // Pre-broadcast check on chain state
        const currentLock = await this.evmAdapter.getLock(lockId);
        if (currentLock.status === 'claimed') {
          this.applyEvent(order, {
            type: 'SOLVER_CLAIM_FINAL',
            txId: currentLock.claimTx.txId,
          });
          this.applyEvent(order, { type: 'SWAP_COMPLETE' });
          return;
        }

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

    // SOLVER REFUND: §5.3 abort edge
    // SOLVER_LOCK_SEEN -> (height >= bchRefundHeight && no claim) -> SOLVER_REFUNDED
    if (
      (order.status === 'SOLVER_LOCK_SEEN' ||
        order.status === 'SOLVER_LOCK_BROADCAST') &&
      !order.userClaimTxId &&
      order.solverLockTxId
    ) {
      const quorum = this.bchClient.getQuorumStatus();
      if (
        quorum.isQuorumHealthy &&
        quorum.quorumTip &&
        quorum.quorumTip >= terms.bchRefundHeight
      ) {
        const existingRefund = this.db.getAction(order.id, 'SOLVER_REFUND');
        if (existingRefund) {
          let intent: { txid: string; txHex: string };
          try {
            intent = JSON.parse(existingRefund.intentPayload);
          } catch {
            intent = { txid: existingRefund.txId || '', txHex: '' };
          }
          if (intent.txid) {
            this.db.recordActionBroadcast(
              order.id,
              'SOLVER_REFUND',
              intent.txid,
            );
            this.applyEvent(order, {
              type: 'BCH_DEADLINE_PASSED',
              refundTxId: intent.txid,
            });
            return;
          }
        }

        this.logger.info(
          {
            orderId: order.id,
            refundHeight: terms.bchRefundHeight,
            tip: quorum.quorumTip,
          },
          'BCH refund height reached without user claim; broadcasting solver BCH refund',
        );

        const refundResult = buildRefundTransaction({
          params: encodeHtlcParameters(order.terms),
          utxo: {
            txid: order.solverLockTxId,
            vout: 0,
            satoshis: order.terms.bchCarrySats,
          },
          network: 'chipnet',
        });

        this.db.recordActionIntent(order.id, 'SOLVER_REFUND', {
          txid: refundResult.txid,
          txHex: refundResult.txHex,
        });

        await this.bchClient.broadcast(refundResult.txHex);
        this.db.recordActionBroadcast(
          order.id,
          'SOLVER_REFUND',
          refundResult.txid,
        );

        this.applyEvent(order, {
          type: 'BCH_DEADLINE_PASSED',
          refundTxId: refundResult.txid,
        });
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

  async buildSolverBchLock(
    order: SolverOrderRecord,
  ): Promise<{ txid: string; txHex: string }> {
    this.logger.info(
      { orderId: order.id },
      'Building real BCH lock transaction with @ferry/htlc-bch buildLockTransaction',
    );

    const solverKeys = await deriveBchKeyDetails(this.solverBchWif);
    const utxos = await this.bchClient.listUnspent(
      solverKeys.scriptHash,
      'include_tokens',
    );

    // Explicit bchCarrySats from order terms
    const result = buildLockTransaction({
      params: order.terms,
      utxos,
      changeAddress: solverKeys.lockingBytecodeHex,
      tokenChangeAddress: solverKeys.lockingBytecodeHex,
      bchCarrySats: order.terms.bchCarrySats,
      wif: this.solverBchWif,
      network: 'chipnet',
    });

    if (!result.signed) {
      throw new Error('Failed to sign solver BCH lock transaction');
    }

    return {
      txid: result.signed.txid,
      txHex: result.signed.txHex,
    };
  }
}
