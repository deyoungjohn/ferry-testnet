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
  public readonly network: 'testnet' | 'mainnet';
  public readonly bchNetwork: 'chipnet' | 'mainnet';
  public readonly bchAddressPrefix: 'bchtest' | 'bitcoincash';
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
    networkOrLogger?: 'testnet' | 'mainnet' | pino.Logger,
    logger?: pino.Logger,
  ) {
    let resolvedNetwork: 'testnet' | 'mainnet' = 'testnet';
    let resolvedLogger: pino.Logger | undefined;

    if (typeof networkOrLogger === 'string') {
      resolvedNetwork = networkOrLogger;
      resolvedLogger = logger;
    } else if (networkOrLogger && typeof networkOrLogger === 'object') {
      resolvedLogger = networkOrLogger;
    }

    if (resolvedNetwork === 'mainnet' && process.env.FAULT_CRASH_POINT) {
      throw new Error(
        'Refusing to start: FAULT_CRASH_POINT is not allowed when network is mainnet',
      );
    }

    this.network = resolvedNetwork;
    this.bchNetwork = resolvedNetwork === 'mainnet' ? 'mainnet' : 'chipnet';
    this.bchAddressPrefix =
      resolvedNetwork === 'mainnet' ? 'bitcoincash' : 'bchtest';

    this.logger =
      resolvedLogger ??
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
    const addresses = deriveHtlcAddresses(bchParams, this.bchNetwork);

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
      const claim = await this.findClaimInHistory(order, scriptHash);
      if (claim) {
        this.applyEvent(order, {
          type: 'USER_CLAIM_SEEN',
          txId: claim.txId,
          secret: claim.secret,
        });
      }
    }
  }

  private triggerFaultInjection(point: string): void {
    if (
      this.network !== 'mainnet' &&
      process.env.FERRY_FAULT_INJECTION === '1' &&
      process.env.FAULT_CRASH_POINT === point
    ) {
      this.logger.warn({ point }, 'Injected fault triggered');
      process.kill(process.pid, 'SIGKILL');
    }
  }

  public async findClaimInHistory(
    order: SolverOrderRecord,
    scriptHash: string,
    history?: Array<{ tx_hash: string; height: number }>,
  ): Promise<{ txId: string; secret: `0x${string}` } | null> {
    const hist = history ?? (await this.bchClient.getHistory(scriptHash));
    const spends = hist.filter((h) => h.tx_hash !== order.solverLockTxId);

    for (const spend of spends) {
      if (typeof this.bchClient.getTransaction !== 'function') continue;
      const rawSpend = await this.bchClient.getTransaction(spend.tx_hash);
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
              return { txId: spend.tx_hash, secret };
            }
          }
        }
      }
    }
    return null;
  }

  public async executeOrAdoptBchTx(params: {
    orderId: string;
    actionType: 'SOLVER_LOCK' | 'SOLVER_REFUND';
    buildTx: () => Promise<{ txid: string; txHex: string }>;
    isOnChain: (txid: string) => Promise<boolean>;
    faultBeforePoint?: string;
    faultAfterPoint?: string;
  }): Promise<{ txid: string; txHex: string; adopted: boolean }> {
    const existingAction = this.db.getAction(params.orderId, params.actionType);
    let txid = '';
    let txHex = '';

    if (existingAction) {
      try {
        const parsed = JSON.parse(existingAction.intentPayload);
        txid = parsed.txid || existingAction.txId || '';
        txHex = parsed.txHex || '';
      } catch {
        txid = existingAction.txId || '';
      }
    }

    if (txid) {
      // 1. Check if already on chain
      const alreadyMined = await params.isOnChain(txid);
      if (alreadyMined) {
        this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
        return { txid, txHex, adopted: true };
      }

      // 2. Not on chain yet; rebroadcast the SAME signed bytes
      if (txHex) {
        try {
          await this.bchClient.broadcast(txHex);
        } catch (err: unknown) {
          this.logger.debug(
            { err, txid },
            'Rebroadcast returned error (may already be in mempool or confirmed)',
          );
        }
      }
      this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
      return { txid, txHex, adopted: false };
    }

    // 3. First time execution: build tx first
    const built = await params.buildTx();
    txid = built.txid;
    txHex = built.txHex;

    // Persist intent with { txid, txHex } ahead of broadcast
    this.db.recordActionIntent(params.orderId, params.actionType, {
      txid,
      txHex,
    });

    if (params.faultBeforePoint) {
      this.triggerFaultInjection(params.faultBeforePoint);
    }

    // Broadcast
    await this.bchClient.broadcast(txHex);

    if (params.faultAfterPoint) {
      this.triggerFaultInjection(params.faultAfterPoint);
    }

    this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
    return { txid, txHex, adopted: false };
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
      const shHex = await this.ensureBchSubscription(order);
      const startDetect = Date.now();

      const result = await this.executeOrAdoptBchTx({
        orderId: order.id,
        actionType: 'SOLVER_LOCK',
        buildTx: () => this.buildSolverBchLock(order),
        isOnChain: async (txid) => {
          const utxos = await this.bchClient.listUnspent(
            shHex,
            'include_tokens',
          );
          if (utxos.some((u) => u.tx_hash === txid)) return true;
          const history = await this.bchClient.getHistory(shHex);
          return history.some((h) => h.tx_hash === txid);
        },
        faultBeforePoint: 'BEFORE_BCH_LOCK_BROADCAST',
        faultAfterPoint: 'AFTER_BCH_LOCK_BROADCAST',
      });

      const latency = Date.now() - startDetect;
      this.metrics.lastReactionTimeMs = latency;
      this.metrics.reactionTimesMs.push(latency);

      this.applyEvent(order, {
        type: 'SOLVER_LOCK_BROADCAST',
        txId: result.txid,
      });

      await this.ensureBchSubscription(order);
    }

    // USER_CLAIM_SEEN -> SOLVER_CLAIM_BROADCAST
    if (order.status === 'USER_CLAIM_SEEN' && order.secret) {
      await this.processSolverClaim(order, lockId);
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

    // SOLVER REFUND: §5.3 abort edge & §4.2 refund vs claim race
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
        const shHex = await this.ensureBchSubscription(order);
        const history = await this.bchClient.getHistory(shHex);
        const utxos = await this.bchClient.listUnspent(shHex, 'include_tokens');

        // 1. Re-check if spent by user claim (revealing secret)
        const claimResult = await this.findClaimInHistory(
          order,
          shHex,
          history,
        );
        if (claimResult) {
          this.logger.info(
            { orderId: order.id, txId: claimResult.txId },
            'User claim found on BCH at refund check; proceeding to claim EVM funds',
          );
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: claimResult.txId,
            secret: claimResult.secret,
          });
          await this.processSolverClaim(order, lockId);
        } else {
          // 2. Check if our refund transaction was already broadcast / mined
          const existingRefund = this.db.getAction(order.id, 'SOLVER_REFUND');
          let existingRefundTxid = '';
          if (existingRefund) {
            try {
              existingRefundTxid =
                JSON.parse(existingRefund.intentPayload).txid ||
                existingRefund.txId ||
                '';
            } catch {
              existingRefundTxid = existingRefund.txId || '';
            }
          }

          const refundOnChain = existingRefundTxid
            ? history.some((h) => h.tx_hash === existingRefundTxid) ||
              utxos.some((u) => u.tx_hash === existingRefundTxid)
            : false;

          if (refundOnChain) {
            this.logger.info(
              { orderId: order.id, refundTxId: existingRefundTxid },
              'Solver BCH refund is already on chain; adopting',
            );
            this.db.recordActionBroadcast(
              order.id,
              'SOLVER_REFUND',
              existingRefundTxid,
            );
            this.applyEvent(order, {
              type: 'BCH_DEADLINE_PASSED',
              refundTxId: existingRefundTxid,
            });
            return;
          }

          // 3. Confirm the HTLC output is unspent before building refund
          const lockUtxo = utxos.find(
            (u) => u.tx_hash === order.solverLockTxId,
          );
          if (!lockUtxo) {
            this.logger.warn(
              { orderId: order.id, solverLockTxId: order.solverLockTxId },
              'HTLC output is not unspent in UTXO set; re-checking history for spend',
            );
            const freshHistory = await this.bchClient.getHistory(shHex);
            const freshClaim = await this.findClaimInHistory(
              order,
              shHex,
              freshHistory,
            );
            if (freshClaim) {
              this.applyEvent(order, {
                type: 'USER_CLAIM_SEEN',
                txId: freshClaim.txId,
                secret: freshClaim.secret,
              });
              await this.processSolverClaim(order, lockId);
            }
            return;
          }

          // 4. Output is unspent; execute refund with write-ahead and fault injection
          this.logger.info(
            {
              orderId: order.id,
              refundHeight: terms.bchRefundHeight,
              tip: quorum.quorumTip,
            },
            'BCH refund height reached without user claim; broadcasting solver BCH refund',
          );

          try {
            const result = await this.executeOrAdoptBchTx({
              orderId: order.id,
              actionType: 'SOLVER_REFUND',
              buildTx: async () => {
                const refundResult = buildRefundTransaction({
                  params: encodeHtlcParameters(order.terms),
                  utxo: {
                    txid: order.solverLockTxId!,
                    vout: 0,
                    satoshis: order.terms.bchCarrySats,
                  },
                  network: this.bchNetwork,
                });
                return { txid: refundResult.txid, txHex: refundResult.txHex };
              },
              isOnChain: async (txid) => {
                const currentHistory = await this.bchClient.getHistory(shHex);
                return currentHistory.some((h) => h.tx_hash === txid);
              },
              faultBeforePoint: 'BEFORE_BCH_REFUND_BROADCAST',
              faultAfterPoint: 'AFTER_BCH_REFUND_BROADCAST',
            });

            this.applyEvent(order, {
              type: 'BCH_DEADLINE_PASSED',
              refundTxId: result.txid,
            });
          } catch (err: unknown) {
            this.logger.warn(
              { err, orderId: order.id },
              'Refund broadcast failed; re-checking if user claim occurred concurrently',
            );
            const raceHistory = await this.bchClient.getHistory(shHex);
            const raceClaim = await this.findClaimInHistory(
              order,
              shHex,
              raceHistory,
            );
            if (raceClaim) {
              this.applyEvent(order, {
                type: 'USER_CLAIM_SEEN',
                txId: raceClaim.txId,
                secret: raceClaim.secret,
              });
              await this.processSolverClaim(order, lockId);
            }
          }
        }
      }
    }
  }

  private async processSolverClaim(
    order: SolverOrderRecord,
    lockId: string,
  ): Promise<void> {
    if (!order.secret) return;
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
      network: this.bchNetwork,
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
