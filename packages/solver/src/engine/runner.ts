import pino from 'pino';
import {
  deriveHtlcAddresses,
  displayToInternalCategory,
  encodeHtlcParameters,
  buildLockTransaction,
  buildRefundTransaction,
  buildClaimTransaction,
  verifyClaimTransactionHex,
  verifyRefundTransactionHex,
} from '@ferry/htlc-bch';
import {
  invariantF,
  invariantR,
  revealPolicy,
  isValidSecret,
  assertValidSecret,
  type LockEvent,
  type TxRef,
} from '@ferry/core';
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

export const STALE_CLAIM_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
export const STALE_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (longer for locks than claims)

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
  private inFlightClaims = new Set<string>();
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

    // 1. Startup self-heal pass for broadcast orders
    try {
      await this.selfHealBroadcastOrders();
    } catch (err) {
      this.logger.error({ err }, 'Error during startup self-heal pass');
    }

    // 2. Startup reconciliation
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

    // 4. Poll / event loop for processing order state transitions and history reconciliation
    this.pollInterval = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.step();
        await this.reconcileOrders();
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
    const bchParams = encodeHtlcParameters(order.terms);
    const addresses = deriveHtlcAddresses(bchParams, this.bchNetwork);

    const { sha256: lSha256, binToHex } = await import('@bitauth/libauth');
    const shHex = binToHex(lSha256.hash(addresses.lockingBytecode).reverse());

    if (!this.subscribedScriptHashes.has(shHex)) {
      this.subscribedScriptHashes.add(shHex);
      if (typeof this.bchClient.subscribeScriptHash === 'function') {
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
    }

    return shHex;
  }

  async handleEvmEvent(event: LockEvent): Promise<void> {
    if (event.removed) return;

    const order = this.db.getOrderByLockId(event.lockId);
    if (!order) return;

    if (order.direction === 'COUNTER_TO_BCH') {
      if (event.type === 'Locked') {
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
        this.applyEvent(order, {
          type: 'BCH_DEADLINE_PASSED',
          refundTxId: event.tx.txId,
        });
      }
    } else {
      // Reverse direction: BCH_TO_COUNTER
      if (event.type === 'Locked') {
        if (
          order.status === 'USER_LOCK_FINAL' ||
          order.status === 'SOLVER_LOCK_BROADCAST'
        ) {
          this.applyEvent(order, {
            type: 'SOLVER_LOCK_SEEN',
            txId: event.tx.txId,
          });
        }
      } else if (event.type === 'Claimed') {
        // User claimed EVM lock; secret is revealed in event
        const validSecret =
          event.secret && isValidSecret(event.secret, order.terms.hashLock)
            ? (event.secret as `0x${string}`)
            : undefined;
        if (
          order.status === 'SOLVER_LOCK_SEEN' ||
          order.status === 'SOLVER_LOCK_BROADCAST' ||
          order.status === 'SECRET_KNOWN'
        ) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: event.tx.txId,
            secret: validSecret,
          });
          if (validSecret) {
            await this.processSolverBchClaim(order);
          }
        } else if (
          order.status === 'USER_CLAIM_SEEN' &&
          !order.secret &&
          validSecret
        ) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: event.tx.txId,
            secret: validSecret,
          });
          await this.processSolverBchClaim(order);
        }
      } else if (event.type === 'Refunded') {
        this.applyEvent(order, {
          type: 'COUNTER_DEADLINE_PASSED',
          refundTxId: event.tx.txId,
        });
      }
    }
  }

  async handleBchNotification(
    order: SolverOrderRecord,
    scriptHash: string,
  ): Promise<void> {
    const currentOrder = this.db.getOrder(order.id) ?? order;
    if (currentOrder.direction === 'BCH_TO_COUNTER') {
      await this.checkUserBchLock(currentOrder, scriptHash);
      return;
    }

    const utxos = await this.bchClient.listUnspent(
      scriptHash,
      'include_tokens',
    );

    // 1. Check if solver lock is seen
    if (
      currentOrder.status === 'SOLVER_LOCK_BROADCAST' &&
      currentOrder.solverLockTxId
    ) {
      const hasUtxo = utxos.some(
        (u) => u.tx_hash === currentOrder.solverLockTxId,
      );
      if (hasUtxo) {
        this.applyEvent(currentOrder, {
          type: 'SOLVER_LOCK_SEEN',
          txId: currentOrder.solverLockTxId,
        });
      }
    }

    // 2. Check if user claimed the lock (spent UTXO revealing secret in unlocking script)
    if (
      currentOrder.status === 'SOLVER_LOCK_SEEN' ||
      currentOrder.status === 'SOLVER_LOCK_BROADCAST' ||
      currentOrder.status === 'SECRET_KNOWN'
    ) {
      const claim = await this.findClaimInHistory(currentOrder, scriptHash);
      if (claim) {
        this.applyEvent(currentOrder, {
          type: 'USER_CLAIM_SEEN',
          txId: claim.txId,
          secret: claim.secret,
        });
        const locker = currentOrder.terms.userCounterAddress;
        const lockId = this.evmAdapter.lockId(
          locker as `0x${string}`,
          currentOrder.terms.hashLock,
        );
        await this.processSolverClaim(currentOrder, lockId);
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
      const rawSpend = await this.bchClient.getTransaction(
        spend.tx_hash,
        false,
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
              const detectedAt = Date.now();
              const mempoolStatus = spend.height <= 0 ? 'mempool' : 'confirmed';
              this.logger.info(
                {
                  orderId: order.id,
                  txId: spend.tx_hash,
                  height: spend.height,
                  mempoolStatus,
                  detectedAt,
                },
                'Extracted secret from user claim in BCH history',
              );
              return { txId: spend.tx_hash, secret };
            }
          }
        }
      }
    }
    return null;
  }

  public async isBchTxInMempoolOrChain(
    txid: string,
    scriptHash?: string,
  ): Promise<boolean> {
    try {
      if (scriptHash) {
        const history = await this.bchClient.getHistory(scriptHash);
        if (history.some((h) => h.tx_hash === txid)) return true;
      }
      if (typeof this.bchClient.getTransaction === 'function') {
        const tx = await this.bchClient.getTransaction(txid, false);
        if (tx) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  public async isBchTxInMempoolOrChainAcrossQuorum(
    txid: string,
    scriptHash?: string,
  ): Promise<{
    found: boolean;
    seenOnServers: string[];
    totalConnected: number;
  }> {
    if (
      typeof (this.bchClient as unknown as { checkTxAcrossQuorum?: unknown })
        .checkTxAcrossQuorum === 'function'
    ) {
      return (
        this.bchClient as unknown as {
          checkTxAcrossQuorum: (
            id: string,
            sh?: string,
          ) => Promise<{
            found: boolean;
            seenOnServers: string[];
            totalConnected: number;
          }>;
        }
      ).checkTxAcrossQuorum(txid, scriptHash);
    }
    const found = await this.isBchTxInMempoolOrChain(txid, scriptHash);
    return {
      found,
      seenOnServers: found ? ['default'] : [],
      totalConnected: 1,
    };
  }

  public async checkLockInputsSpentState(
    orderId: string,
    txid: string,
    txHex: string,
  ): Promise<{
    handled: boolean;
    adoptedTx?: { txid: string; txHex: string; adopted: boolean };
    error?: string;
  }> {
    const order = this.db.getOrder(orderId);
    if (!order) return { handled: false };

    let decoded: ReturnType<typeof decodeTransaction>;
    try {
      decoded = decodeTransaction(Buffer.from(txHex, 'hex'));
    } catch {
      return { handled: false };
    }
    if (typeof decoded === 'string') {
      return { handled: false };
    }

    const inputs = decoded.inputs.map((inp) => ({
      txid: Buffer.from(inp.outpointTransactionHash).reverse().toString('hex'),
      vout: inp.outpointIndex,
    }));

    const solverKeys = await deriveBchKeyDetails(this.solverBchWif);
    const unspent = await this.bchClient.listUnspent(
      solverKeys.scriptHash,
      'include_tokens',
    );

    const allInputsUnspent = inputs.every((inp) =>
      unspent.some((u) => u.tx_hash === inp.txid && u.tx_pos === inp.vout),
    );

    if (allInputsUnspent) {
      // Inputs are still unspent! It is safe for the caller to delete the action and rebuild with fresh UTXOs.
      return { handled: false };
    }

    // At least one input was spent! An alternative spend exists on the network: find it by history instead of rebuilding!
    this.logger.info(
      { orderId, txid, inputs },
      'Solver lock input is no longer unspent; searching history for alternative spend instead of rebuilding',
    );

    const htlcScriptHash = await this.ensureBchSubscription(order);

    // 1. Check HTLC history to see if an alternative transaction funded this order's HTLC
    try {
      const htlcHistory = await this.bchClient.getHistory(htlcScriptHash);
      for (const h of htlcHistory) {
        try {
          const txData = await this.bchClient.getTransaction(h.tx_hash, false);
          const rawHex =
            typeof txData === 'string'
              ? txData
              : (txData as { hex?: string })?.hex;
          if (rawHex) {
            const hDecoded = decodeTransaction(Buffer.from(rawHex, 'hex'));
            if (typeof hDecoded !== 'string') {
              const spendsOurInput = hDecoded.inputs.some((inp) => {
                const inTxId = Buffer.from(inp.outpointTransactionHash)
                  .reverse()
                  .toString('hex');
                return inputs.some(
                  (myInp) =>
                    myInp.txid === inTxId && myInp.vout === inp.outpointIndex,
                );
              });
              if (spendsOurInput) {
                this.logger.info(
                  { orderId, originalTxid: txid, winningTxid: h.tx_hash },
                  'Found alternative winning lock transaction in HTLC history; adopting',
                );
                order.solverLockTxId = h.tx_hash;
                this.db.saveOrder(order);
                this.db.recordActionIntent(orderId, 'SOLVER_LOCK', {
                  txid: h.tx_hash,
                  txHex: rawHex,
                });
                this.db.recordActionBroadcast(
                  orderId,
                  'SOLVER_LOCK',
                  h.tx_hash,
                );
                return {
                  handled: true,
                  adoptedTx: { txid: h.tx_hash, txHex: rawHex, adopted: true },
                };
              }
            }
          }
        } catch {
          // Continue checking next history entry
        }
      }
    } catch (err) {
      this.logger.warn({ err, orderId }, 'Failed checking HTLC history');
    }

    // 2. If not in HTLC history, check solver's address history to find the conflicting spend
    try {
      const solverHistory = await this.bchClient.getHistory(
        solverKeys.scriptHash,
      );
      for (const h of solverHistory) {
        if (h.tx_hash === txid) continue;
        try {
          const txData = await this.bchClient.getTransaction(h.tx_hash, false);
          const rawHex =
            typeof txData === 'string'
              ? txData
              : (txData as { hex?: string })?.hex;
          if (rawHex) {
            const hDecoded = decodeTransaction(Buffer.from(rawHex, 'hex'));
            if (typeof hDecoded !== 'string') {
              const spendsOurInput = hDecoded.inputs.some((inp) => {
                const inTxId = Buffer.from(inp.outpointTransactionHash)
                  .reverse()
                  .toString('hex');
                return inputs.some(
                  (myInp) =>
                    myInp.txid === inTxId && myInp.vout === inp.outpointIndex,
                );
              });
              if (spendsOurInput) {
                const errMessage = `Solver lock inputs were spent by conflicting transaction ${h.tx_hash} which does not fund the HTLC`;
                this.logger.error(
                  { orderId, txid, conflictingTxid: h.tx_hash },
                  errMessage,
                );
                order.needsAttention = true;
                order.rejectionReason = errMessage;
                this.db.saveOrder(order);
                return {
                  handled: true,
                  error: errMessage,
                };
              }
            }
          }
        } catch {
          // Continue
        }
      }
    } catch (err) {
      this.logger.warn({ err, orderId }, 'Failed checking solver history');
    }

    // 3. Inputs are missing from listUnspent, but not yet identified in history
    const errMessage = `Solver lock inputs for order ${orderId} are no longer unspent, but winning spend not yet identified in history`;
    this.logger.error({ orderId, txid }, errMessage);
    order.needsAttention = true;
    order.rejectionReason = errMessage;
    this.db.saveOrder(order);
    return {
      handled: true,
      error: errMessage,
    };
  }

  public async executeOrAdoptBchTx(params: {
    orderId: string;
    actionType: 'SOLVER_LOCK' | 'SOLVER_REFUND' | 'SOLVER_CLAIM';
    buildTx: () => Promise<{ txid: string; txHex: string }>;
    isOnChain: (txid: string) => Promise<boolean>;
    verifyTx?: (txHex: string) => Promise<true | string> | true | string;
    staleBroadcastTimeoutMs?: number;
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

      // If we have txHex and a verifyTx callback, verify with the script VM
      if (txHex && params.verifyTx) {
        const verifyResult = await params.verifyTx(txHex);
        if (verifyResult !== true) {
          const errMsg =
            typeof verifyResult === 'string'
              ? verifyResult
              : 'VM verification failed';
          this.logger.warn(
            {
              orderId: params.orderId,
              actionType: params.actionType,
              txid,
              err: errMsg,
            },
            'Stored BCH action txHex failed VM verification against current UTXO set; deleting action and rebuilding',
          );
          this.db.deleteAction(params.orderId, params.actionType);
          txid = '';
          txHex = '';
        }
      }
    }

    if (txid) {
      // 1. Check if already on chain
      const alreadyMined = await params.isOnChain(txid);
      if (alreadyMined) {
        this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
        return { txid, txHex, adopted: true };
      }

      // 2. Check if stale broadcast (not in mempool and not in block after N minutes)
      const defaultTimeout =
        params.actionType === 'SOLVER_LOCK'
          ? STALE_LOCK_TIMEOUT_MS
          : STALE_CLAIM_TIMEOUT_MS;
      const staleTimeoutMs = params.staleBroadcastTimeoutMs ?? defaultTimeout;
      const actionAge = Date.now() - (existingAction?.updatedAt ?? 0);
      if (
        existingAction?.status === 'BROADCAST' &&
        actionAge > staleTimeoutMs
      ) {
        let htlcScriptHash: string | undefined;
        const order = this.db.getOrder(params.orderId);
        if (order) {
          htlcScriptHash = await this.ensureBchSubscription(order);
        }

        const quorumCheck = await this.isBchTxInMempoolOrChainAcrossQuorum(
          txid,
          htlcScriptHash,
        );

        if (quorumCheck.found) {
          if (
            quorumCheck.totalConnected > 1 &&
            quorumCheck.seenOnServers.length < quorumCheck.totalConnected
          ) {
            this.logger.info(
              {
                orderId: params.orderId,
                txid,
                seenOn: quorumCheck.seenOnServers,
              },
              'BCH tx found on quorum server but missing on peer(s); rebroadcasting to assist propagation',
            );
            if (txHex) {
              try {
                await this.bchClient.broadcast(txHex);
              } catch {
                // Ignore broadcast error on peer
              }
            }
          }
          this.db.recordActionBroadcast(
            params.orderId,
            params.actionType,
            txid,
          );
          return { txid, txHex, adopted: false };
        }

        // For SOLVER_LOCK: check spent state of inputs before declaring stale!
        if (params.actionType === 'SOLVER_LOCK' && txHex) {
          const inputCheck = await this.checkLockInputsSpentState(
            params.orderId,
            txid,
            txHex,
          );
          if (inputCheck.handled) {
            if (inputCheck.adoptedTx) {
              return inputCheck.adoptedTx;
            }
            throw new Error(
              inputCheck.error ||
                'Solver lock inputs spent by conflicting transaction',
            );
          }
        }

        this.logger.warn(
          {
            orderId: params.orderId,
            actionType: params.actionType,
            txid,
            actionAgeMs: actionAge,
          },
          'BCH broadcast action is stale (not in mempool or chain across quorum nodes, inputs unspent); deleting action to allow rebuild',
        );
        this.db.deleteAction(params.orderId, params.actionType);
        txid = '';
        txHex = '';
      }
    }

    if (txid) {
      // 3. Not on chain yet; rebroadcast the SAME signed bytes
      if (txHex) {
        try {
          await this.bchClient.broadcast(txHex);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (
            errMsg.includes('mandatory-script-verify-flag-failed') ||
            errMsg.includes('rejected')
          ) {
            this.logger.error(
              {
                err,
                orderId: params.orderId,
                actionType: params.actionType,
                txid,
              },
              'Node rejected BCH rebroadcast with script error; deleting action and marking needs_attention',
            );
            this.db.deleteAction(params.orderId, params.actionType);
            const order = this.db.getOrder(params.orderId);
            if (order) {
              order.needsAttention = true;
              order.rejectionReason = `Node rejected broadcast: ${errMsg}`;
              this.db.saveOrder(order);
            }
            throw err;
          }
          this.logger.debug(
            { err, txid },
            'Rebroadcast returned error (may already be in mempool or confirmed)',
          );
        }
      }
      this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
      return { txid, txHex, adopted: false };
    }

    // 4. First time execution or rebuild: build tx first
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

    // Broadcast with rejection handling
    try {
      await this.bchClient.broadcast(txHex);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        {
          err,
          orderId: params.orderId,
          actionType: params.actionType,
          txid,
        },
        'Node rejected BCH broadcast; marking needs_attention and deleting bad action',
      );
      this.db.deleteAction(params.orderId, params.actionType);
      const order = this.db.getOrder(params.orderId);
      if (order) {
        order.needsAttention = true;
        order.rejectionReason = `Node rejected broadcast: ${errMsg}`;
        this.db.saveOrder(order);
      }
      throw err;
    }

    if (params.faultAfterPoint) {
      this.triggerFaultInjection(params.faultAfterPoint);
    }

    this.db.recordActionBroadcast(params.orderId, params.actionType, txid);
    return { txid, txHex, adopted: false };
  }

  public async selfHealBroadcastOrders(): Promise<void> {
    const orders = this.db.listNonTerminalOrders();
    for (const order of orders) {
      if (
        order.status !== 'SOLVER_CLAIM_BROADCAST' &&
        order.status !== 'SOLVER_LOCK_BROADCAST'
      ) {
        continue;
      }

      const isReverse = order.direction === 'BCH_TO_COUNTER';
      const lockerAddress = isReverse
        ? (order.terms.solverCounterAddress as `0x${string}`)
        : (order.terms.userCounterAddress as `0x${string}`);
      const lockId = this.evmAdapter.lockId(
        lockerAddress,
        order.terms.hashLock,
      );

      if (order.status === 'SOLVER_CLAIM_BROADCAST') {
        if (isReverse) {
          // Solver was claiming BCH tokens from user BCH lock
          const shHex = await this.ensureBchSubscription(order);
          const txid = order.solverClaimTxId;
          const inMempoolOrChain = txid
            ? await this.isBchTxInMempoolOrChain(txid, shHex)
            : false;
          if (!inMempoolOrChain) {
            this.logger.warn(
              { orderId: order.id, txid },
              'Startup self-heal: reverse SOLVER_CLAIM_BROADCAST tx not found in mempool or chain; resetting to USER_CLAIM_SEEN for rebuild',
            );
            this.db.deleteAction(order.id, 'SOLVER_CLAIM');
            order.status = 'USER_CLAIM_SEEN';
            order.solverClaimTxId = undefined;
            order.updatedAt = Date.now();
            this.db.saveOrder(order);
          }
        } else {
          // Solver was claiming counter assets on EVM
          const txid = order.solverClaimTxId;
          const inMempoolOrChain =
            txid &&
            typeof (
              this.evmAdapter as {
                isTxMinedOrPending?: (h: string) => Promise<boolean>;
              }
            ).isTxMinedOrPending === 'function'
              ? await (
                  this.evmAdapter as {
                    isTxMinedOrPending: (h: string) => Promise<boolean>;
                  }
                ).isTxMinedOrPending(txid)
              : false;
          if (!inMempoolOrChain) {
            const currentLock = await this.evmAdapter.getLock(lockId);
            if (currentLock.status === 'locked') {
              this.logger.warn(
                { orderId: order.id, txid },
                'Startup self-heal: forward SOLVER_CLAIM_BROADCAST tx not found in mempool or chain; resetting to USER_CLAIM_SEEN for rebuild',
              );
              this.db.deleteAction(order.id, 'SOLVER_CLAIM');
              order.status = 'USER_CLAIM_SEEN';
              order.solverClaimTxId = undefined;
              order.updatedAt = Date.now();
              this.db.saveOrder(order);
            }
          }
        }
      } else if (order.status === 'SOLVER_LOCK_BROADCAST') {
        if (isReverse) {
          // Solver was locking EVM counter assets
          const txid = order.solverLockTxId;
          const inMempoolOrChain =
            txid &&
            typeof (
              this.evmAdapter as {
                isTxMinedOrPending?: (h: string) => Promise<boolean>;
              }
            ).isTxMinedOrPending === 'function'
              ? await (
                  this.evmAdapter as {
                    isTxMinedOrPending: (h: string) => Promise<boolean>;
                  }
                ).isTxMinedOrPending(txid)
              : false;
          if (!inMempoolOrChain) {
            const currentLock = await this.evmAdapter.getLock(lockId);
            if (currentLock.status === 'absent') {
              this.logger.warn(
                { orderId: order.id, txid },
                'Startup self-heal: reverse SOLVER_LOCK_BROADCAST tx not found and lock absent; resetting to USER_LOCK_FINAL to re-lock',
              );
              this.db.deleteAction(order.id, 'SOLVER_LOCK');
              order.status = 'USER_LOCK_FINAL';
              order.solverLockTxId = undefined;
              order.updatedAt = Date.now();
              this.db.saveOrder(order);
            }
          }
        } else {
          // Solver was locking BCH tokens
          const shHex = await this.ensureBchSubscription(order);
          const txid = order.solverLockTxId;
          const quorumCheck = txid
            ? await this.isBchTxInMempoolOrChainAcrossQuorum(txid, shHex)
            : { found: false, seenOnServers: [], totalConnected: 0 };
          if (!quorumCheck.found) {
            const utxos = await this.bchClient.listUnspent(
              shHex,
              'include_tokens',
            );
            const lockExists = utxos.some((u) => u.tx_hash === txid);
            if (!lockExists) {
              const action = this.db.getAction(order.id, 'SOLVER_LOCK');
              let parsedTxHex = '';
              if (action?.intentPayload) {
                try {
                  parsedTxHex = JSON.parse(action.intentPayload).txHex || '';
                } catch {
                  // Ignore JSON parse error
                }
              }
              if (parsedTxHex && txid) {
                const inputCheck = await this.checkLockInputsSpentState(
                  order.id,
                  txid,
                  parsedTxHex,
                );
                if (inputCheck.handled) {
                  continue; // Either adopted winning spend or flagged needsAttention
                }
              }

              this.logger.warn(
                { orderId: order.id, txid },
                'Startup self-heal: forward SOLVER_LOCK_BROADCAST tx not found in mempool or chain (inputs unspent); resetting to USER_LOCK_FINAL to re-lock',
              );
              this.db.deleteAction(order.id, 'SOLVER_LOCK');
              order.status = 'USER_LOCK_FINAL';
              order.solverLockTxId = undefined;
              order.updatedAt = Date.now();
              this.db.saveOrder(order);
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
    const isReverse = order.direction === 'BCH_TO_COUNTER';
    const lockerAddress = isReverse
      ? (order.terms.solverCounterAddress as `0x${string}`)
      : (order.terms.userCounterAddress as `0x${string}`);
    const lockId = this.evmAdapter.lockId(lockerAddress, order.terms.hashLock);
    const evmLock = await this.evmAdapter.getLock(lockId);

    if (isReverse) {
      if (evmLock.status === 'locked') {
        if (
          order.status === 'USER_LOCK_FINAL' ||
          order.status === 'SOLVER_LOCK_BROADCAST'
        ) {
          this.applyEvent(order, {
            type: 'SOLVER_LOCK_SEEN',
            txId: evmLock.lockTx?.txId || order.solverLockTxId || '',
          });
        }
      } else if (evmLock.status === 'claimed') {
        const validSecret =
          evmLock.secret && isValidSecret(evmLock.secret, order.terms.hashLock)
            ? (evmLock.secret as `0x${string}`)
            : undefined;
        if (
          order.status === 'SOLVER_LOCK_SEEN' ||
          order.status === 'SOLVER_LOCK_BROADCAST' ||
          order.status === 'SECRET_KNOWN'
        ) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: evmLock.claimTx.txId,
            secret: validSecret,
          });
        } else if (
          order.status === 'USER_CLAIM_SEEN' &&
          !order.secret &&
          validSecret
        ) {
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: evmLock.claimTx.txId,
            secret: validSecret,
          });
        }
      } else if (evmLock.status === 'refunded') {
        this.applyEvent(order, {
          type: 'COUNTER_DEADLINE_PASSED',
          refundTxId: evmLock.refundTx.txId,
        });
      }

      if (order.status !== 'DONE' && order.status !== 'REJECTED') {
        const shHex = await this.ensureBchSubscription(order);
        await this.handleBchNotification(order, shHex);
      }
      return;
    }

    // EVM Lock state reconciliation (forward)
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
    const isReverse = order.direction === 'BCH_TO_COUNTER';
    const lockerAddress = isReverse
      ? (terms.solverCounterAddress as `0x${string}`)
      : (terms.userCounterAddress as `0x${string}`);
    const lockId = this.evmAdapter.lockId(lockerAddress, terms.hashLock);

    if (isReverse) {
      await this.processReverseOrder(order, lockId);
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // 0. Forward quote expiry: transition abandoned QUOTED order to EXPIRED
    if (order.status === 'QUOTED') {
      if (now > terms.quoteExpiry) {
        this.applyEvent(order, { type: 'QUOTE_EXPIRED' });
        return;
      }
    }

    // USER_LOCK_FINAL -> SOLVER_LOCK_BROADCAST
    if (order.status === 'USER_LOCK_FINAL') {
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

      // Check pay link invoice reservation collision (PL-02)
      if (order.payLinkId) {
        const link = this.db.getPayLink(order.payLinkId);
        if (link && link.kind === 'invoice') {
          if (
            link.status === 'paid' ||
            (link.status === 'reserved' &&
              link.orderId &&
              link.orderId !== order.id)
          ) {
            this.logger.warn(
              {
                orderId: order.id,
                payLinkId: order.payLinkId,
                linkStatus: link.status,
                reservedOrderId: link.orderId,
              },
              'Invoice is already reserved or paid by another order; refusing to counter-lock',
            );
            this.applyEvent(order, {
              type: 'INVALID_TERMS',
              reason: 'Invoice is already reserved or paid by another order',
            });
            return;
          }
        }
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
                  verifyWithVm: true,
                });
                return { txid: refundResult.txid, txHex: refundResult.txHex };
              },
              verifyTx: (txHex) => {
                return verifyRefundTransactionHex({
                  params: encodeHtlcParameters(order.terms),
                  utxo: {
                    txid: order.solverLockTxId!,
                    vout: 0,
                    satoshis: order.terms.bchCarrySats,
                  },
                  txHex,
                  network: this.bchNetwork,
                });
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
    if (this.inFlightClaims.has(order.id)) {
      this.logger.debug(
        { orderId: order.id },
        'EVM claim is already in-flight for order',
      );
      return;
    }

    const existingAction = this.db.getAction(order.id, 'SOLVER_CLAIM');
    if (existingAction && existingAction.status === 'BROADCAST') {
      return;
    }

    this.inFlightClaims.add(order.id);
    try {
      const startClaim = Date.now();
      this.db.recordActionIntent(order.id, 'SOLVER_CLAIM', {
        lockId,
      });

      // Pre-broadcast check on chain state for idempotency (Blueprint §11.3 /)
      const currentLock = await this.evmAdapter.getLock(lockId);
      if (currentLock.status === 'claimed') {
        this.logger.info(
          { orderId: order.id, claimTxId: currentLock.claimTx.txId },
          'EVM lock already claimed on chain; adopting claim tx',
        );
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: currentLock.claimTx.txId,
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
        return;
      }

      if (currentLock.status === 'locked') {
        let claimTx: TxRef;
        try {
          claimTx = await this.evmAdapter.claim(lockId, order.secret);
        } catch (err: unknown) {
          // Re-verify on chain state in case of concurrent execution / NotLocked()
          const recheck = await this.evmAdapter.getLock(lockId);
          if (recheck.status === 'claimed') {
            this.logger.info(
              { orderId: order.id, claimTxId: recheck.claimTx.txId },
              'EVM claim caught error but lock is claimed on chain; adopting',
            );
            claimTx = recheck.claimTx;
          } else {
            throw err;
          }
        }

        this.db.recordActionBroadcast(order.id, 'SOLVER_CLAIM', claimTx.txId);

        const latency = Date.now() - startClaim;
        this.metrics.lastReactionTimeMs = latency;
        this.metrics.reactionTimesMs.push(latency);

        this.logger.info(
          {
            orderId: order.id,
            claimTxId: claimTx.txId,
            reactionLatencyMs: latency,
          },
          'Solver EVM claim broadcast successfully',
        );

        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_BROADCAST',
          txId: claimTx.txId,
        });
      } else {
        this.logger.warn(
          { orderId: order.id, lockStatus: currentLock.status },
          'Cannot claim EVM lock; lock is neither locked nor claimed',
        );
      }
    } finally {
      this.inFlightClaims.delete(order.id);
    }
  }

  private async checkUserBchLock(
    order: SolverOrderRecord,
    scriptHash: string,
  ): Promise<void> {
    const utxos = await this.bchClient.listUnspent(
      scriptHash,
      'include_tokens',
    );
    const { binToHex } = await import('@bitauth/libauth');
    const expectedDisplay = order.terms.bchTokenCategory
      .toLowerCase()
      .replace(/^0x/, '');
    const internalBytes = displayToInternalCategory(
      order.terms.bchTokenCategory,
    );
    const expectedInternal = binToHex(internalBytes).toLowerCase();

    // 1. Filter UTXOs matching category
    const categoryUtxos = utxos.filter((u) => {
      if (!u.token_data) return false;
      const cat = u.token_data.category.toLowerCase().replace(/^0x/, '');
      return cat === expectedDisplay || cat === expectedInternal;
    });

    if (categoryUtxos.length === 0) {
      return;
    }

    // 2. Validate exact token amount and sufficient BCH carry
    const validLockUtxo = categoryUtxos.find((u) => {
      const exactAmount =
        BigInt(u.token_data!.amount) === order.terms.bchTokenAmount;
      const sufficientCarry = BigInt(u.value) >= order.terms.bchCarrySats;
      return exactAmount && sufficientCarry;
    });

    if (!validLockUtxo) {
      // User funded address with matching category but invalid amount or carry
      const candidate = categoryUtxos[0]!;
      const actualAmount = BigInt(candidate.token_data!.amount);
      const actualCarry = BigInt(candidate.value);
      let reason: string;
      if (actualAmount !== order.terms.bchTokenAmount) {
        reason = `Token amount ${actualAmount} does not match exact quoted amount ${order.terms.bchTokenAmount}`;
      } else {
        reason = `Lock carry ${actualCarry} sats is below required ${order.terms.bchCarrySats} sats`;
      }
      this.logger.warn(
        { orderId: order.id, actualAmount, actualCarry, reason },
        'User BCH lock has invalid terms; rejecting',
      );
      this.applyEvent(order, {
        type: 'INVALID_TERMS',
        reason,
      });
      return;
    }

    // 3. Valid lock seen
    if (order.status === 'QUOTED') {
      this.applyEvent(order, {
        type: 'USER_LOCK_SEEN',
        txId: validLockUtxo.tx_hash,
      });
    }

    // 4. Reveal policy evaluation
    const quorum = this.bchClient.getQuorumStatus();
    const confirmations =
      validLockUtxo.height !== undefined &&
      validLockUtxo.height > 0 &&
      quorum.quorumTip > 0
        ? Math.max(1, quorum.quorumTip - validLockUtxo.height + 1)
        : 0;

    let dsproof: 'clear' | 'detected' | 'unavailable' | undefined;
    let dsproofElapsedMs: number | undefined;

    if (confirmations === 0) {
      if (!order.firstSeenAt) {
        order.firstSeenAt = Date.now();
        this.db.saveOrder(order);
      }
      dsproofElapsedMs = Date.now() - order.firstSeenAt;

      // Query Fulcrum DSProof status if client provides getDSProof
      if (typeof this.bchClient.getDSProof === 'function') {
        try {
          const proof = await this.bchClient.getDSProof(validLockUtxo.tx_hash);
          dsproof = proof ? 'detected' : 'clear';
        } catch {
          dsproof = 'unavailable';
        }
      } else {
        dsproof = 'unavailable';
      }
    }

    const amountUsdMicros = order.terms.bchTokenAmount * 10_000n; // 2 decimals -> 6 decimals ($)
    const decision = revealPolicy({
      chain: 'bch',
      amountUsdMicros,
      lane: order.lane ?? 'safe',
      fastOptIn: order.fastOptIn ?? false,
      evidence: {
        exists: true,
        confirmations,
        ...(dsproof ? { dsproof } : {}),
        ...(dsproofElapsedMs !== undefined ? { dsproofElapsedMs } : {}),
      },
    });

    if (decision.reason === 'dsproof') {
      this.logger.warn(
        { orderId: order.id, txId: validLockUtxo.tx_hash },
        'Double-spend proof detected on user BCH lock; rejecting order',
      );
      this.applyEvent(order, {
        type: 'INVALID_TERMS',
        reason: 'Double-spend proof detected on user lock',
      });
      return;
    }

    if (
      decision.allowed &&
      (order.status === 'QUOTED' || order.status === 'USER_LOCK_SEEN')
    ) {
      this.applyEvent(order, {
        type: 'USER_LOCK_FINAL',
        txId: validLockUtxo.tx_hash,
      });
    }
  }

  private async processReverseOrder(
    order: SolverOrderRecord,
    lockId: string,
  ): Promise<void> {
    const terms = order.terms;
    const now = Math.floor(Date.now() / 1000);

    // 1. In QUOTED or USER_LOCK_SEEN: check for user's BCH lock UTXO
    if (order.status === 'QUOTED' || order.status === 'USER_LOCK_SEEN') {
      const shHex = await this.ensureBchSubscription(order);
      await this.checkUserBchLock(order, shHex);
      if (order.status === 'QUOTED' && now > terms.quoteExpiry) {
        this.applyEvent(order, { type: 'QUOTE_EXPIRED' });
        return;
      }
    }

    // 2. USER_LOCK_FINAL -> SOLVER_LOCK_BROADCAST (Solver counter-locks on EVM)
    if (order.status === 'USER_LOCK_FINAL') {
      // Check quote expiry against when the user lock was first deposited/seen
      const lockSeenTime = order.firstSeenAt
        ? Math.floor(order.firstSeenAt / 1000)
        : now;
      if (lockSeenTime > terms.quoteExpiry) {
        this.logger.warn(
          { orderId: order.id, quoteExpiry: terms.quoteExpiry, lockSeenTime },
          'Quote expired before user lock was deposited in reverse swap; refusing to counter-lock',
        );
        this.applyEvent(order, {
          type: 'INVALID_TERMS',
          reason: 'Quote expired before user lock finalized',
        });
        return;
      }

      // Check Invariant R at counter-lock time t0
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
      const timingDecision = invariantR(
        {
          counterDeadline: terms.counterDeadline,
          bchRefundHeight: terms.bchRefundHeight,
        },
        { unixSeconds: now, bchTipHeight },
      );
      if (!timingDecision.allowed) {
        this.logger.warn(
          { orderId: order.id, reason: timingDecision.reason },
          'Invariant R violation at counter-lock time; refusing to counter-lock',
        );
        this.applyEvent(order, {
          type: 'INVALID_TERMS',
          reason: `Invariant R violation at counter-lock: ${timingDecision.reason}`,
        });
        return;
      }

      // Pre-broadcast check on EVM chain state
      const currentLock = await this.evmAdapter.getLock(lockId);
      if (currentLock.status === 'locked') {
        this.logger.info(
          { orderId: order.id, lockTxId: currentLock.lockTx.txId },
          'Solver EVM counter-lock already on chain; adopting',
        );
        this.db.recordActionBroadcast(
          order.id,
          'SOLVER_LOCK',
          currentLock.lockTx.txId,
        );
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_BROADCAST',
          txId: currentLock.lockTx.txId,
        });
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_SEEN',
          txId: currentLock.lockTx.txId,
        });
        return;
      }

      // Write-ahead intent for EVM lock
      const existingAction = this.db.getAction(order.id, 'SOLVER_LOCK');
      if (!existingAction || existingAction.status === 'PENDING') {
        this.db.recordActionIntent(order.id, 'SOLVER_LOCK', { lockId });
        this.triggerFaultInjection('BEFORE_EVM_LOCK_BROADCAST');
        const lockTx = await this.evmAdapter.lock(order.terms);
        this.triggerFaultInjection('AFTER_EVM_LOCK_BROADCAST');
        this.db.recordActionBroadcast(order.id, 'SOLVER_LOCK', lockTx.txId);
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_BROADCAST',
          txId: lockTx.txId,
        });
      }
    }

    // 3. SOLVER_LOCK_BROADCAST -> SOLVER_LOCK_SEEN -> SOLVER_LOCK_FINAL
    if (order.status === 'SOLVER_LOCK_BROADCAST' && order.solverLockTxId) {
      const currentLock = await this.evmAdapter.getLock(lockId);
      if (currentLock.status === 'locked') {
        this.applyEvent(order, {
          type: 'SOLVER_LOCK_SEEN',
          txId: order.solverLockTxId,
        });
      }
    }

    // 4. Check if user claimed on EVM (revealing secret)
    if (
      order.status === 'SOLVER_LOCK_SEEN' ||
      order.status === 'SOLVER_LOCK_BROADCAST' ||
      order.status === 'SECRET_KNOWN'
    ) {
      const currentLock = await this.evmAdapter.getLock(lockId);
      if (currentLock.status === 'claimed') {
        const validSecret =
          currentLock.secret &&
          isValidSecret(currentLock.secret, order.terms.hashLock)
            ? (currentLock.secret as `0x${string}`)
            : undefined;
        this.logger.info(
          {
            orderId: order.id,
            claimTx: currentLock.claimTx.txId,
            hasSecret: Boolean(validSecret),
          },
          'User claimed on EVM; proceeding to record claim and claim BCH tokens if secret known',
        );
        this.applyEvent(order, {
          type: 'USER_CLAIM_SEEN',
          txId: currentLock.claimTx.txId,
          secret: validSecret,
        });
        if (validSecret) {
          await this.processSolverBchClaim(order);
          return;
        }
      }
    }

    // 5. USER_CLAIM_SEEN -> SOLVER_CLAIM_BROADCAST (Solver claims BCH tokens)
    if (order.status === 'USER_CLAIM_SEEN' && order.secret) {
      await this.processSolverBchClaim(order);
    }

    // 6. SOLVER_CLAIM_BROADCAST -> SOLVER_CLAIM_FINAL -> DONE
    if (order.status === 'SOLVER_CLAIM_BROADCAST' && order.solverClaimTxId) {
      const shHex = await this.ensureBchSubscription(order);
      const history = await this.bchClient.getHistory(shHex);
      const claimOnChain = history.some(
        (h) => h.tx_hash === order.solverClaimTxId,
      );
      if (claimOnChain) {
        this.applyEvent(order, {
          type: 'SOLVER_CLAIM_FINAL',
          txId: order.solverClaimTxId,
        });
        this.applyEvent(order, { type: 'SWAP_COMPLETE' });
      }
    }

    // 7. Abort edge: Solver EVM refund after counterDeadline
    if (
      (order.status === 'SOLVER_LOCK_SEEN' ||
        order.status === 'SOLVER_LOCK_BROADCAST' ||
        order.status === 'SECRET_KNOWN') &&
      !order.userClaimTxId
    ) {
      if (now >= terms.counterDeadline) {
        const currentLock = await this.evmAdapter.getLock(lockId);
        if (currentLock.status === 'claimed') {
          const validSecret =
            currentLock.secret &&
            isValidSecret(currentLock.secret, order.terms.hashLock)
              ? (currentLock.secret as `0x${string}`)
              : undefined;
          this.logger.info(
            { orderId: order.id, hasSecret: Boolean(validSecret) },
            'User claimed EVM lock at deadline; proceeding to claim BCH if secret known',
          );
          this.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: currentLock.claimTx.txId,
            secret: validSecret,
          });
          if (validSecret) {
            await this.processSolverBchClaim(order);
            return;
          }
        }

        if (currentLock.status === 'locked') {
          this.logger.info(
            { orderId: order.id, deadline: terms.counterDeadline, now },
            'EVM counterDeadline reached without user claim; broadcasting solver EVM refund',
          );
          try {
            const refundTx = await this.evmAdapter.refund(lockId);
            this.applyEvent(order, {
              type: 'COUNTER_DEADLINE_PASSED',
              refundTxId: refundTx.txId,
            });
          } catch (err: unknown) {
            this.logger.warn(
              { err, orderId: order.id },
              'EVM refund broadcast failed; re-checking lock state',
            );
            const recheck = await this.evmAdapter.getLock(lockId);
            if (recheck.status === 'claimed') {
              const validSecret =
                recheck.secret &&
                isValidSecret(recheck.secret, order.terms.hashLock)
                  ? (recheck.secret as `0x${string}`)
                  : undefined;
              this.applyEvent(order, {
                type: 'USER_CLAIM_SEEN',
                txId: recheck.claimTx.txId,
                secret: validSecret,
              });
              if (validSecret) {
                await this.processSolverBchClaim(order);
              }
            }
          }
        } else if (currentLock.status === 'refunded') {
          this.applyEvent(order, {
            type: 'COUNTER_DEADLINE_PASSED',
            refundTxId: currentLock.refundTx.txId,
          });
        }
      }
    }
  }

  public async processSolverBchClaim(order: SolverOrderRecord): Promise<void> {
    if (!order.secret) return;
    assertValidSecret(order.secret, order.terms.hashLock);
    const shHex = await this.ensureBchSubscription(order);
    const utxos = await this.bchClient.listUnspent(shHex, 'include_tokens');
    const userUtxo =
      utxos.find((u) => u.tx_hash === order.userLockTxId) ?? utxos[0];

    if (!userUtxo) {
      this.logger.warn(
        { orderId: order.id },
        'No UTXO available yet to claim user BCH lock; will retry',
      );
      return;
    }

    const htlcParams = encodeHtlcParameters(order.terms);
    const claimUtxo = {
      txid: userUtxo.tx_hash,
      vout: userUtxo.tx_pos ?? 0,
      satoshis: userUtxo.value ?? order.terms.bchCarrySats,
    };

    const result = await this.executeOrAdoptBchTx({
      orderId: order.id,
      actionType: 'SOLVER_CLAIM',
      buildTx: async () => {
        if (!userUtxo) {
          throw new Error('No UTXO available to claim user BCH lock');
        }
        const claimResult = buildClaimTransaction({
          params: htlcParams,
          utxo: claimUtxo,
          secret: order.secret!,
          network: this.bchNetwork,
          verifyWithVm: true,
        });
        return { txid: claimResult.txid, txHex: claimResult.txHex };
      },
      verifyTx: (txHex) => {
        return verifyClaimTransactionHex({
          params: htlcParams,
          utxo: claimUtxo,
          txHex,
          network: this.bchNetwork,
        });
      },
      isOnChain: async (txid) => {
        const history = await this.bchClient.getHistory(shHex);
        return history.some((h) => h.tx_hash === txid);
      },
      faultBeforePoint: 'BEFORE_BCH_CLAIM_BROADCAST',
      faultAfterPoint: 'AFTER_BCH_CLAIM_BROADCAST',
    });

    this.applyEvent(order, {
      type: 'SOLVER_CLAIM_BROADCAST',
      txId: result.txid,
    });
  }

  applyEvent(order: SolverOrderRecord, event: SolverEvent): void {
    const res = transition(order, event);
    order.status = res.nextStatus;
    if (res.mutations) {
      Object.assign(order, res.mutations);
    }
    order.updatedAt = Date.now();
    this.db.saveOrder(order);

    // Sync pay link status if this order is linked to a pay link
    if (order.payLinkId) {
      const payLink = this.db.getPayLink(order.payLinkId);
      if (payLink) {
        if (order.status === 'DONE') {
          this.db.updatePayLinkStatus(payLink.id, 'paid', order.id);
        } else if (
          order.status === 'EXPIRED' ||
          order.status === 'REJECTED' ||
          order.status === 'SOLVER_REFUNDED'
        ) {
          if (payLink.status === 'reserved' && payLink.orderId === order.id) {
            this.db.updatePayLinkStatus(payLink.id, 'open', null);
          }
        }
      }
    }
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
