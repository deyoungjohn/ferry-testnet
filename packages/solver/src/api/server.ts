import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import pino from 'pino';
import { privateKeyToAccount } from 'viem/accounts';
import {
  QuoteRequestSchema,
  QuoteResponseSchema,
  OrderStatusResponseSchema,
  RevealSecretRequestSchema,
  RevealSecretResponseSchema,
  RelayLockRequestSchema,
  RelayLockResponseSchema,
  RelayClaimRequestSchema,
  RelayClaimResponseSchema,
  HealthResponseSchema,
  StatsSummarySchema,
  RecentSwapsResponseSchema,
  PegsResponseSchema,
  CreatePayLinkRequestSchema,
  CreatePayLinkResponseSchema,
  GetPayLinkResponseSchema,
  PayLinkQuoteRequestSchema,
  ListPayLinksQuerySchema,
  ListPayLinksResponseSchema,
  CancelPayLinkRequestSchema,
  CancelPayLinkResponseSchema,
  parseOrderTerms,
  orderId as computeOrderId,
  signOrderId,
  quoteExactIn,
  quoteExactOut,
  checkLimits,
  pegGuard,
  invariantF,
  invariantR,
  revealPolicy,
  DEFAULT_REVEAL_CONFIG,
} from '@ferry/core';
import type { OrderTerms } from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import { deriveBchKeyDetails } from '../bch/lock-builder.js';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import type { SolverConfig } from '../config.js';
import type { SolverEngine } from '../engine/runner.js';
import type { SolverOrderRecord } from '../state-machine/types.js';
import {
  type PriceSource,
  TestnetStubPriceSource,
} from '../pricing/price-source.js';
import type { PayLinkRecord } from '../db/database.js';
import {
  createLinkId,
  verifyPayLinkSignature,
  verifyPayLinksSignature,
} from '../paylink/link.js';

function toPayLinkWire(link: PayLinkRecord) {
  return {
    id: link.id,
    kind: link.kind,
    recipientCashaddr: link.recipientCashaddr,
    recipientLockingBytecode: link.recipientLockingBytecode,
    token: link.token,
    ...(link.amountOut !== undefined ? { amountOut: link.amountOut } : {}),
    ...(link.minAmountOut !== undefined
      ? { minAmountOut: link.minAmountOut }
      : {}),
    ...(link.memo !== undefined ? { memo: link.memo } : {}),
    ...(link.reference !== undefined ? { reference: link.reference } : {}),
    ...(link.expiresAt !== undefined ? { expiresAt: link.expiresAt } : {}),
    verified: link.verified,
    status: link.status,
    createdAt: link.createdAt,
    ...(link.orderId !== undefined ? { orderId: link.orderId } : {}),
  };
}

export interface SolverServerOptions {
  config: SolverConfig;
  db: SolverDatabase;
  evmAdapter: EvmChainAdapter;
  bchClient: BchQuorumClient;
  engine: SolverEngine;
  priceSource?: PriceSource;
  logger?: pino.Logger;
}

export function buildServer(options: SolverServerOptions): FastifyInstance {
  const logger =
    options.logger ||
    pino({
      level: 'info',
      // Ensure secrets are never logged
      redact: ['req.body.secret', 'body.secret', 'secret'],
    });

  const app = Fastify({ loggerInstance: logger });
  app.register(cors, { origin: true });

  // Custom serializer to safely stringify BigInt values across all API responses
  app.setReplySerializer((payload) => {
    return JSON.stringify(payload, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  });

  // Global 404 handler returning typed error envelope
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
    });
  });

  // Global error handler ensuring all errors return typed code and never expose raw stack traces
  app.setErrorHandler((error: unknown, request, reply) => {
    const err = (error && typeof error === 'object' ? error : {}) as {
      statusCode?: number;
      code?: string;
      name?: string;
      message?: string;
    };

    const isPayloadTooLarge =
      err.statusCode === 413 ||
      err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      (typeof err.message === 'string' &&
        err.message.toLowerCase().includes('body is too large'));

    if (isPayloadTooLarge) {
      return reply.status(413).send({
        code: 'BAD_REQUEST',
        message: 'Request payload exceeds maximum allowed size',
      });
    }

    const isSyntaxOrContentType =
      err.statusCode === 400 ||
      err.name === 'SyntaxError' ||
      err.code === 'FST_ERR_CTP_INVALID_CONTENT_TYPE' ||
      err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY';

    if (isSyntaxOrContentType) {
      return reply.status(400).send({
        code: 'BAD_REQUEST',
        message: err.message || 'Malformed or invalid request payload',
      });
    }

    const statusCode =
      typeof err.statusCode === 'number' &&
      err.statusCode >= 400 &&
      err.statusCode < 600
        ? err.statusCode
        : 500;

    logger.error(
      { err: error, url: request.url, method: request.method },
      'Unhandled API error',
    );

    return reply.status(statusCode).send({
      code: err.code || 'INTERNAL_ERROR',
      message: err.message || 'Internal server error',
    });
  });

  const { config, db, evmAdapter, bchClient, engine } = options;
  const priceSource = options.priceSource ?? new TestnetStubPriceSource(logger);
  const solverAccount = privateKeyToAccount(
    config.solverEvmPrivateKey as `0x${string}`,
  );
  const solverAddress = solverAccount.address.toLowerCase();

  // 1. POST /v1/quotes
  app.post('/v1/quotes', async (req, reply) => {
    const parseResult = QuoteRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'INVALID_QUOTE_REQUEST',
        message: 'Invalid quote request payload',
        issues: parseResult.error.issues,
      });
    }

    const request = parseResult.data;

    if (!config.quotingEnabled) {
      return reply.status(503).send({
        code: 'QUOTING_DISABLED',
        message: 'Quoting is temporarily disabled',
      });
    }

    // Check EVM tip health
    try {
      const evmTip = await evmAdapter.getTip();
      if (
        evmTip.height <= 0 ||
        evmTip.ageSeconds > config.tipMaxAgeBaseSeconds
      ) {
        return reply.status(503).send({
          code: 'EVM_TIP_UNHEALTHY',
          message: 'EVM chain tip is stale or invalid; quoting disabled',
        });
      }
    } catch {
      return reply.status(503).send({
        code: 'EVM_TIP_UNHEALTHY',
        message: 'EVM chain tip is unreachable; quoting disabled',
      });
    }

    // Check limits
    const isReverse = request.direction === 'BCH_TO_COUNTER';
    const amountIn = request.amountIn;
    const inDecimals = isReverse ? 2 : 6;
    const isWithinLimits = checkLimits(amountIn, inDecimals, {
      minUsdMicros: config.minSwapUsdMicros,
      maxUsdMicros: config.maxSwapUsdMicros,
    });
    if (!isWithinLimits) {
      return reply.status(400).send({
        code: 'AMOUNT_OUT_OF_BOUNDS',
        message: 'Requested swap amount exceeds bounds',
      });
    }

    // Fast lane validations (opt-in and cap)
    if (request.lane === 'fast') {
      if (!request.fastOptIn) {
        return reply.status(400).send({
          code: 'FAST_LANE_OPT_IN_REQUIRED',
          message: 'Fast lane requires explicit fastOptIn=true',
        });
      }
      const amountUsdMicros = isReverse ? amountIn * 10_000n : amountIn;
      if (amountUsdMicros > DEFAULT_REVEAL_CONFIG.zeroConfMaxUsdMicros) {
        return reply.status(400).send({
          code: 'FAST_LANE_CAP_EXCEEDED',
          message: `Fast lane amount exceeds maximum zero-conf limit of ${Number(DEFAULT_REVEAL_CONFIG.zeroConfMaxUsdMicros) / 1e6} USD`,
        });
      }
    }

    // Peg guard check via PriceSource
    const prices = await priceSource.getPrices(request.counterSymbol);
    const pegToleranceMicros = BigInt(Math.round(config.pegTolerance * 1e6));
    const isPegHealthy = pegGuard(prices, pegToleranceMicros);
    if (!isPegHealthy) {
      return reply.status(503).send({
        code: 'PEG_DEVIATION',
        message: 'Stablecoin peg deviation exceeds safety threshold',
      });
    }

    // Check tip ages and quorum health
    const quorum = bchClient.getQuorumStatus();
    if (
      !quorum.isQuorumHealthy ||
      !quorum.quorumTip ||
      quorum.quorumTip <= 0 ||
      quorum.ageSeconds > config.tipMaxAgeBchSeconds
    ) {
      return reply.status(503).send({
        code: 'BCH_TIP_UNHEALTHY',
        message:
          'BCH quorum is unhealthy or tip is unknown/stale; quoting disabled',
      });
    }

    // Check uniqueness constraint on (userCounterAddress, hashLock)
    const existingOrder = db.getOrderByUserAndHashLock(
      request.userCounterAddress,
      request.hashLock,
    );
    if (existingOrder) {
      return reply.status(400).send({
        code: 'DUPLICATE_ORDER',
        message:
          'An order for this user counter address and hashLock already exists',
      });
    }

    // Compute quote
    let bchTokenAmount: bigint;
    let counterAmount: bigint;
    if (isReverse) {
      bchTokenAmount = amountIn;
      counterAmount = quoteExactIn(amountIn, 2, 6, {
        spreadBps: config.spreadBps,
        fixedFeeUsdMicros: config.fixedFeeUsdMicros,
      });
    } else {
      counterAmount = amountIn;
      bchTokenAmount = quoteExactIn(amountIn, 6, 2, {
        spreadBps: config.spreadBps,
        fixedFeeUsdMicros: config.fixedFeeUsdMicros,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const quoteExpiry =
      now + (isReverse && (request.lane ?? 'safe') === 'safe' ? 180 : 120); // 3 mins for reverse safe lane, 2 mins otherwise (D-A2-010)

    let counterDeadline: number;
    let bchRefundHeight: number;

    if (isReverse) {
      counterDeadline = now + 6 * 3600; // 6 hours
      bchRefundHeight = quorum.quorumTip + 144; // ~24h of BCH blocks

      const timingDecision = invariantR(
        { counterDeadline, bchRefundHeight },
        { unixSeconds: now, bchTipHeight: quorum.quorumTip },
      );
      if (!timingDecision.allowed) {
        return reply.status(400).send({
          code: 'INVARIANT_R_FAILED',
          message: `Timing invariant R check failed: ${timingDecision.reason}`,
        });
      }
    } else {
      counterDeadline = now + 86400; // 24 hours
      bchRefundHeight = quorum.quorumTip + 36;

      // Invariant F check
      const timingDecision = invariantF(
        { counterDeadline, bchRefundHeight },
        { unixSeconds: now, bchTipHeight: quorum.quorumTip },
      );
      if (!timingDecision.allowed) {
        return reply.status(400).send({
          code: 'INVARIANT_F_FAILED',
          message: `Timing invariant F check failed: ${timingDecision.reason}`,
        });
      }
    }

    let solverBchLockingBytecode: `0x${string}` =
      '0x76a914000000000000000000000000000000000000000088ac';
    if (config.solverBchWif) {
      const solverKeys = await deriveBchKeyDetails(
        config.solverBchWif,
        config.network === 'mainnet' ? 'bitcoincash' : 'bchtest',
      );
      solverBchLockingBytecode = (
        solverKeys.lockingBytecodeHex.startsWith('0x')
          ? solverKeys.lockingBytecodeHex
          : `0x${solverKeys.lockingBytecodeHex}`
      ) as `0x${string}`;
    }

    // Construct terms
    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: request.direction,
      bchToken: request.bchToken,
      bchTokenCategory: config.tpusdCategory.startsWith('0x')
        ? (config.tpusdCategory as `0x${string}`)
        : (`0x${config.tpusdCategory}` as `0x${string}`),
      bchTokenAmount,
      counterAmount,
      counterChain: request.counterChain,
      counterNetworkId: config.baseChainId,
      counterAsset: {
        symbol: request.counterSymbol,
        decimals: 6,
        address: config.baseUsdcAddress,
      },
      counterHtlc: config.baseHtlcAddress,
      userCounterAddress: request.userCounterAddress,
      userBchLockingBytecode: request.userBchLockingBytecode,
      solverCounterAddress: solverAddress,
      solverBchLockingBytecode,
      hashLock: request.hashLock,
      counterDeadline,
      bchRefundHeight,
      bchCarrySats: 3000n,
      bchMaxFee: 1500n,
      quoteId: `quote-${now}-${Math.random().toString(36).slice(2, 8)}`,
      quoteExpiry,
    });

    const orderId = computeOrderId(terms);
    const signature = await signOrderId(orderId, solverAccount);

    // Save initial QUOTED order in DB
    const orderRecord: SolverOrderRecord = {
      id: orderId,
      direction: terms.direction,
      status: 'QUOTED',
      lane: request.lane ?? 'safe',
      fastOptIn: request.fastOptIn ?? false,
      terms,
      hashLock: terms.hashLock,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    db.saveOrder(orderRecord);

    const response = {
      orderId,
      terms,
      lane: request.lane ?? 'safe',
      signature,
      signerAddress: solverAddress,
    };

    QuoteResponseSchema.parse(response);
    return reply.status(200).send(response);
  });

  // 2. GET /v1/orders/:id
  app.get('/v1/orders/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = db.getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: 'ORDER_NOT_FOUND',
        message: `Order ${id} not found`,
      });
    }

    const signature = await signOrderId(
      order.id as `0x${string}`,
      solverAccount,
    );

    // CRITICAL PRIVACY RULE:
    // Never return secret unless it is already public on chain (seen in a claim);
    // never echo a cooperative-reveal secret back before then.
    const isPublicOnChain = order.secretSource === 'on_chain_claim';
    const secretToReturn =
      isPublicOnChain && order.secret ? order.secret : undefined;

    const bchTxId =
      order.terms.direction === 'BCH_TO_COUNTER'
        ? order.userLockTxId
        : order.solverLockTxId;
    const bchLock = bchTxId
      ? {
          txid: bchTxId,
          vout: 0,
          satoshis: order.terms.bchCarrySats,
        }
      : undefined;

    const response = {
      orderId: order.id,
      status: order.status,
      lane: order.lane ?? 'safe',
      terms: order.terms,
      signature,
      signerAddress: solverAddress,
      txIds: {
        userLockTxId: order.userLockTxId,
        solverLockTxId: order.solverLockTxId,
        userClaimTxId: order.userClaimTxId,
        solverClaimTxId: order.solverClaimTxId,
        solverRefundTxId: order.solverRefundTxId,
      },
      bchLock,
      secret: secretToReturn,
      deadlines: {
        quoteExpiry: order.terms.quoteExpiry,
        counterDeadline: order.terms.counterDeadline,
        bchRefundHeight: order.terms.bchRefundHeight,
      },
      rejectionReason: order.rejectionReason,
      updatedAt: order.updatedAt,
    };

    return reply.status(200).send(OrderStatusResponseSchema.parse(response));
  });

  // 3. POST /v1/orders/:id/secret (cooperative reveal)
  app.post('/v1/orders/:id/secret', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = db.getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: 'ORDER_NOT_FOUND',
        message: `Order ${id} not found`,
      });
    }

    const parseResult = RevealSecretRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'INVALID_SECRET_REQUEST',
        message: 'Invalid secret format (expected 32-byte hex)',
      });
    }

    const { secret } = parseResult.data;

    // Verify secret matches hashLock
    const { sha256 } = await import('viem');
    if (sha256(secret) !== order.hashLock) {
      return reply.status(400).send({
        code: 'HASH_LOCK_MISMATCH',
        message: 'Provided secret does not match hashLock',
      });
    }

    // Verify reveal policy with real chain evidence
    let policyResult;
    if (order.terms.direction === 'BCH_TO_COUNTER') {
      const bchLockExists = Boolean(order.userLockTxId);
      const confs =
        order.status === 'USER_LOCK_FINAL' ||
        order.status === 'SOLVER_LOCK_SEEN' ||
        order.status === 'SOLVER_LOCK_BROADCAST' ||
        order.status === 'SECRET_KNOWN' ||
        order.status === 'USER_CLAIM_SEEN' ||
        order.status === 'SOLVER_CLAIM_BROADCAST' ||
        order.status === 'SOLVER_CLAIM_FINAL' ||
        order.status === 'DONE'
          ? 1
          : 0;

      policyResult = revealPolicy({
        chain: 'bch',
        lane: 'safe',
        fastOptIn: false,
        amountUsdMicros: order.terms.counterAmount,
        evidence: {
          exists: bchLockExists,
          confirmations: confs,
        },
      });
    } else {
      const lockId = evmAdapter.lockId(
        order.terms.userCounterAddress as `0x${string}`,
        order.terms.hashLock,
      );
      let evmLock;
      let confs = 0;
      let safeFinal = false;
      try {
        evmLock = await evmAdapter.getLock(lockId);
        if (evmLock.status === 'locked') {
          safeFinal = await evmAdapter.isFinal(evmLock.lockTx, 'safe');
          confs = safeFinal ? config.evmConfs : 1;
        }
      } catch (err: unknown) {
        logger.error(
          { err, orderId: order.id },
          'Failed to query EVM lock status from chain',
        );
        return reply.status(502).send({
          code: 'UPSTREAM_ERROR',
          message: 'Failed to query EVM lock status from chain',
        });
      }

      policyResult = revealPolicy({
        chain: order.terms.counterChain,
        lane: 'safe',
        fastOptIn: false,
        amountUsdMicros: order.terms.counterAmount,
        evidence: {
          exists: evmLock.status === 'locked',
          confirmations: confs,
          safe: safeFinal,
        },
      });
    }

    if (!policyResult.allowed) {
      return reply.status(400).send({
        code: 'REVEAL_POLICY_REJECTED',
        message: `Cooperative reveal rejected by policy: ${policyResult.reason}`,
      });
    }

    try {
      engine.applyEvent(order, {
        type: 'SECRET_REVEALED_COOPERATIVE',
        secret: secret as `0x${string}`,
      });
    } catch (err: unknown) {
      return reply.status(409).send({
        code: 'INVALID_STATE_FOR_REVEAL',
        message: (err as Error).message,
      });
    }

    const response = {
      accepted: true,
      orderId: order.id,
      status: order.status,
    };
    RevealSecretResponseSchema.parse(response);
    return reply.status(200).send(response);
  });

  // 4. POST /v1/orders/:id/relay-lock
  app.post('/v1/orders/:id/relay-lock', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = db.getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: 'ORDER_NOT_FOUND',
        message: `Order ${id} not found`,
      });
    }

    const parseResult = RelayLockRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'INVALID_RELAY_LOCK_REQUEST',
        message: 'Invalid relay lock payload',
        issues: parseResult.error.issues,
      });
    }

    const relayReq = parseResult.data;

    if (order.terms.direction !== 'COUNTER_TO_BCH') {
      return reply.status(400).send({
        code: 'UNSUPPORTED_ROUTE',
        message: 'Relay lock is only supported for COUNTER_TO_BCH orders',
      });
    }

    if (order.status !== 'QUOTED') {
      return reply.status(409).send({
        code: 'INVALID_ORDER_STATE',
        message: `Order ${id} is in status ${order.status}; expected QUOTED`,
      });
    }

    const now = Math.floor(Date.now() / 1000);
    if (order.terms.quoteExpiry < now) {
      return reply.status(410).send({
        code: 'QUOTE_EXPIRED',
        message: 'Order quote has expired',
      });
    }

    // Verify permit deadline hasn't expired
    if (relayReq.permitDeadline < BigInt(now)) {
      return reply.status(400).send({
        code: 'PERMIT_EXPIRED',
        message: 'EIP-2612 permit deadline has expired',
      });
    }

    try {
      // Execute relay lock on EVM adapter
      const txRef = await evmAdapter.relayLock({
        orderId: order.id as `0x${string}`,
        chain: order.terms.counterChain,
        payload: relayReq,
      });

      // Record lock event
      engine.applyEvent(order, {
        type: 'USER_LOCK_SEEN',
        txId: txRef.txId,
      });

      const response = {
        orderId: order.id,
        status: order.status,
        tx: txRef,
      };
      RelayLockResponseSchema.parse(response);
      return reply.status(200).send(response);
    } catch (err: unknown) {
      logger.error({ err, orderId: order.id }, 'Relay lock execution failed');
      return reply.status(500).send({
        code: 'RELAY_LOCK_FAILED',
        message: (err as Error).message,
      });
    }
  });

  // 5. POST /v1/orders/:id/relay-claim
  app.post('/v1/orders/:id/relay-claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const order = db.getOrder(id);
    if (!order) {
      return reply.status(404).send({
        code: 'ORDER_NOT_FOUND',
        message: `Order ${id} not found`,
      });
    }

    const parseResult = RelayClaimRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'INVALID_RELAY_CLAIM_REQUEST',
        message: 'Invalid relay claim payload',
        issues: parseResult.error.issues,
      });
    }

    const { secret, lockId: reqLockId } = parseResult.data;

    if (order.direction !== 'BCH_TO_COUNTER') {
      return reply.status(400).send({
        code: 'UNSUPPORTED_ROUTE',
        message: 'Relay claim is only supported for BCH_TO_COUNTER orders',
      });
    }

    // Verify secret matches hashLock
    const { sha256 } = await import('viem');
    if (sha256(secret) !== order.hashLock) {
      return reply.status(400).send({
        code: 'HASH_LOCK_MISMATCH',
        message: 'Provided secret does not match hashLock',
      });
    }

    // Determine locker address and compute EVM lockId
    const locker =
      order.direction === 'BCH_TO_COUNTER'
        ? order.terms.solverCounterAddress
        : order.terms.userCounterAddress;
    const expectedLockId = evmAdapter.lockId(
      locker as `0x${string}`,
      order.terms.hashLock,
    );

    if (reqLockId && reqLockId.toLowerCase() !== expectedLockId.toLowerCase()) {
      return reply.status(400).send({
        code: 'LOCK_ID_MISMATCH',
        message: 'Supplied lockId does not match order parameters',
      });
    }

    try {
      const currentLock = await evmAdapter.getLock(expectedLockId);
      let txRef;

      if (currentLock.status === 'claimed') {
        txRef = currentLock.claimTx ?? {
          chain: order.terms.counterChain,
          txId:
            order.userClaimTxId ??
            '0x0000000000000000000000000000000000000000000000000000000000000000',
        };
        try {
          engine.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: txRef.txId,
            secret,
          });
        } catch {
          // Claim already recorded in state
        }
      } else if (currentLock.status === 'locked') {
        txRef = await evmAdapter.claim(expectedLockId, secret);
        try {
          engine.applyEvent(order, {
            type: 'USER_CLAIM_SEEN',
            txId: txRef.txId,
            secret,
          });
        } catch {
          // Claim already recorded in state
        }
        if (order.direction === 'BCH_TO_COUNTER') {
          void engine.processSolverBchClaim(order).catch((err) => {
            logger.warn(
              { err, orderId: order.id },
              'Background BCH claim triggered by relay-claim failed; runner will retry',
            );
          });
        }
      } else {
        return reply.status(409).send({
          code: 'LOCK_NOT_ACTIVE',
          message: `EVM lock status is ${currentLock.status}; cannot claim`,
        });
      }

      const response = {
        orderId: order.id,
        status: order.status,
        tx: txRef,
      };
      RelayClaimResponseSchema.parse(response);
      return reply.status(200).send(response);
    } catch (err: unknown) {
      logger.error({ err, orderId: order.id }, 'Relay claim execution failed');
      return reply.status(500).send({
        code: 'RELAY_CLAIM_FAILED',
        message: (err as Error).message,
      });
    }
  });

  // 6. GET /v1/health
  app.get('/v1/health', async (_req, reply) => {
    const quorum = bchClient.getQuorumStatus();
    const staleBch = quorum.ageSeconds > config.tipMaxAgeBchSeconds;
    const isQuorumOk = quorum.isQuorumHealthy && quorum.quorumTip > 0;
    const isBchHealthy = isQuorumOk && !staleBch;

    let baseTipStatus: { height: number; ageSeconds: number; stale: boolean };
    try {
      const tip = await evmAdapter.getTip();
      const staleBase = tip.ageSeconds > config.tipMaxAgeBaseSeconds;
      baseTipStatus = {
        height: tip.height,
        ageSeconds: Math.max(0, tip.ageSeconds),
        stale: staleBase,
      };
    } catch {
      baseTipStatus = {
        height: 0,
        ageSeconds: config.tipMaxAgeBaseSeconds + 1,
        stale: true,
      };
    }

    const isBaseHealthy = !baseTipStatus.stale && baseTipStatus.height > 0;
    const ok = isBchHealthy && isBaseHealthy && config.quotingEnabled;

    const response = {
      ok,
      quotingEnabled: config.quotingEnabled,
      quoting: ok,
      bchTip: {
        height: quorum.quorumTip,
        ageSeconds: Math.max(
          0,
          quorum.ageSeconds === Infinity ? 0 : quorum.ageSeconds,
        ),
        stale: staleBch,
        quorum: quorum.isQuorumHealthy,
      },
      counterTips: {
        base: baseTipStatus,
      },
      inventory: [
        {
          chain: 'bch' as const,
          symbol: 'PUSD' as const,
          decimals: 2,
          balance: 9999999400n,
        },
        {
          chain: 'base' as const,
          symbol: 'USDC' as const,
          decimals: 6,
          balance: 20000000n,
        },
      ],
      timestamp: Math.floor(Date.now() / 1000),
    };

    HealthResponseSchema.parse(response);
    return reply.status(200).send(response);
  });

  // 7. GET /v1/stats
  app.get('/v1/stats', async (_req, reply) => {
    const stats = db.getStatsSummary(
      config.spreadBps,
      config.fixedFeeUsdMicros,
    );
    const validated = StatsSummarySchema.parse(stats);
    return reply.status(200).send(validated);
  });

  // 8. GET /v1/orders/recent
  app.get('/v1/orders/recent', async (_req, reply) => {
    const swaps = db.getRecentSwaps(50);
    const validated = RecentSwapsResponseSchema.parse({ swaps });
    return reply.status(200).send(validated);
  });

  // 9. GET /v1/pegs
  app.get('/v1/pegs', async (_req, reply) => {
    const response = {
      pegs: [
        {
          token: 'PUSD' as const,
          priceUsdMicros: null,
          points: [],
          source: 'testnet-stub',
          asOf: null,
        },
        {
          token: 'MUSD' as const,
          priceUsdMicros: null,
          points: [],
          source: 'testnet-stub',
          asOf: null,
        },
      ],
    };
    const validated = PegsResponseSchema.parse(response);
    return reply.status(200).send(validated);
  });

  // 10. POST /v1/links
  app.post('/v1/links', async (req, reply) => {
    const parseResult = CreatePayLinkRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid create pay link payload',
        details: { issues: parseResult.error.issues },
      });
    }

    const data = parseResult.data;
    const now = Math.floor(Date.now() / 1000);

    if (data.expiresAt !== undefined && data.expiresAt <= now) {
      return reply.status(410).send({
        code: 'LINK_EXPIRED',
        message: 'Expiry must be in the future',
      });
    }

    const verified = data.verification
      ? verifyPayLinkSignature(
          data.verification.challenge,
          data.verification.signature,
          data.recipientLockingBytecode,
          config.allowMockPaylinkSignatures,
        )
      : false;

    let id = createLinkId();
    while (db.getPayLink(id)) {
      id = createLinkId();
    }

    const link = {
      id,
      kind: data.kind,
      recipientCashaddr: data.recipientCashaddr,
      recipientLockingBytecode: data.recipientLockingBytecode,
      token: data.token,
      amountOut: data.amountOut,
      minAmountOut: data.minAmountOut,
      memo: data.memo,
      reference: data.reference,
      expiresAt: data.expiresAt,
      verified,
      status: 'open' as const,
      createdAt: now,
      updatedAt: now,
    };

    db.savePayLink(link);
    const validated = CreatePayLinkResponseSchema.parse(toPayLinkWire(link));
    return reply.status(200).send(validated);
  });

  // 11. GET /v1/links
  app.get('/v1/links', async (req, reply) => {
    const parseResult = ListPayLinksQuerySchema.safeParse(req.query);
    if (!parseResult.success) {
      return reply.status(400).send({
        code: 'VALIDATION_ERROR',
        message: 'Invalid list pay links query parameters',
        details: { issues: parseResult.error.issues },
      });
    }

    const query = parseResult.data;
    if (!config.allowMockPaylinkSignatures) {
      return reply.status(403).send({
        code: 'MOCK_SIGNATURES_DISABLED',
        message:
          'Owner pay-link listing requires real signatures; mock signatures are disabled without ALLOW_MOCK_PAYLINK_SIGNATURES=1',
      });
    }

    if (
      !verifyPayLinksSignature(
        query.owner,
        query.challenge,
        query.sig,
        config.allowMockPaylinkSignatures,
      )
    ) {
      return reply.status(400).send({
        code: 'INVALID_SIGNATURE',
        message: 'Link list challenge is invalid',
      });
    }

    const links = db.listPayLinksByRecipient(query.owner);
    const validated = ListPayLinksResponseSchema.parse({
      links: links.map(toPayLinkWire),
    });
    return reply.status(200).send(validated);
  });

  // 12. GET /v1/links/:id
  app.get<{ Params: { id: string } }>('/v1/links/:id', async (req, reply) => {
    const { id } = req.params;
    const link = db.getPayLink(id);
    if (!link) {
      return reply.status(404).send({
        code: 'LINK_NOT_FOUND',
        message: 'Pay link not found',
      });
    }

    const validated = GetPayLinkResponseSchema.parse(toPayLinkWire(link));
    return reply.status(200).send(validated);
  });

  // 13. POST /v1/links/:id/quotes
  app.post<{ Params: { id: string } }>(
    '/v1/links/:id/quotes',
    async (req, reply) => {
      const { id } = req.params;
      const link = db.getPayLink(id);
      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Pay link not found',
        });
      }

      if (link.status === 'reserved') {
        return reply.status(409).send({
          code: 'LINK_RESERVED',
          message: 'This invoice is being paid',
        });
      }
      if (link.status === 'paid') {
        return reply.status(409).send({
          code: 'LINK_CLOSED',
          message: 'This pay link is already paid',
        });
      }
      if (link.status === 'expired') {
        return reply.status(410).send({
          code: 'LINK_EXPIRED',
          message: 'This pay link has expired',
        });
      }
      if (link.status === 'cancelled') {
        return reply.status(409).send({
          code: 'LINK_CLOSED',
          message: 'This pay link was cancelled',
        });
      }

      const parseResult = PayLinkQuoteRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid pay link quote request payload',
          details: { issues: parseResult.error.issues },
        });
      }

      const request = parseResult.data;

      if (!config.quotingEnabled) {
        return reply.status(503).send({
          code: 'QUOTING_DISABLED',
          message: 'Quoting is temporarily disabled',
        });
      }

      // Check EVM tip health
      try {
        const evmTip = await evmAdapter.getTip();
        if (
          evmTip.height <= 0 ||
          evmTip.ageSeconds > config.tipMaxAgeBaseSeconds
        ) {
          return reply.status(503).send({
            code: 'EVM_TIP_UNHEALTHY',
            message: 'EVM chain tip is stale or invalid; quoting disabled',
          });
        }
      } catch {
        return reply.status(503).send({
          code: 'EVM_TIP_UNHEALTHY',
          message: 'EVM chain tip is unreachable; quoting disabled',
        });
      }
      if (link.token !== 'PUSD') {
        return reply.status(400).send({
          code: 'UNSUPPORTED_ROUTE',
          message: 'Only tPUSD is enabled',
        });
      }
      if (request.counterChain !== 'base' || request.counterSymbol !== 'USDC') {
        return reply.status(400).send({
          code: 'UNSUPPORTED_ROUTE',
          message: 'Only Base USDC is enabled',
        });
      }
      if (request.lane === 'fast' && request.fastOptIn !== true) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Fast lane requires explicit opt-in',
        });
      }

      const amountOut =
        link.kind === 'invoice' ? link.amountOut : request.amountOut;
      if (amountOut === undefined || amountOut <= 0n) {
        return reply.status(400).send({
          code: 'AMOUNT_OUT_OF_RANGE',
          message: 'Enter an amount above zero',
        });
      }
      if (link.minAmountOut !== undefined && amountOut < link.minAmountOut) {
        return reply.status(400).send({
          code: 'AMOUNT_OUT_OF_RANGE',
          message: 'Amount is below this link minimum',
        });
      }

      if (!config.quotingEnabled) {
        return reply.status(503).send({
          code: 'QUOTING_DISABLED',
          message: 'Quoting is temporarily disabled',
        });
      }

      // Check tip freshness and quorum health
      const quorum = bchClient.getQuorumStatus();
      if (
        !quorum.isQuorumHealthy ||
        !quorum.quorumTip ||
        quorum.quorumTip <= 0 ||
        quorum.ageSeconds > config.tipMaxAgeBchSeconds
      ) {
        return reply.status(503).send({
          code: 'STALE_CHAIN_TIP',
          message:
            'BCH quorum is unhealthy or tip is unknown/stale; quoting paused',
        });
      }

      // Check peg stability
      const prices = await priceSource.getPrices(link.token);
      const pegToleranceMicros = BigInt(Math.round(config.pegTolerance * 1e6));
      const isPegSafe = pegGuard(prices, pegToleranceMicros);
      if (!isPegSafe) {
        return reply.status(503).send({
          code: 'PEG_DEVIATION',
          message: 'Underlying peg deviates beyond tolerance; quoting paused',
        });
      }

      // Calculate amountIn via quoteExactOut
      const amountIn = quoteExactOut(amountOut, 6, 2, {
        spreadBps: config.spreadBps,
        fixedFeeUsdMicros: config.fixedFeeUsdMicros,
      });

      const isWithinLimits = checkLimits(amountIn, 6, {
        minUsdMicros: config.minSwapUsdMicros,
        maxUsdMicros: config.maxSwapUsdMicros,
      });
      if (!isWithinLimits) {
        return reply.status(400).send({
          code: 'AMOUNT_OUT_OF_RANGE',
          message: 'Amount is outside the swap limits',
        });
      }

      if (request.lane === 'fast' && amountIn > config.zeroConfMaxUsdMicros) {
        return reply.status(400).send({
          code: 'AMOUNT_OUT_OF_RANGE',
          message: 'Fast lane is limited to $25',
        });
      }

      const now = Math.floor(Date.now() / 1000);
      const quoteExpiry =
        link.expiresAt === undefined
          ? now + config.quoteTtlSeconds
          : Math.min(now + config.quoteTtlSeconds, link.expiresAt);

      if (quoteExpiry <= now) {
        return reply.status(410).send({
          code: 'LINK_EXPIRED',
          message: 'This pay link has expired',
        });
      }

      // Check Invariant F
      const bchTipHeight = quorum.quorumTip;
      const counterDeadline = now + config.fwdEvmDeadlineSeconds;
      const bchRefundHeight = bchTipHeight + config.fwdBchRefundBlocks;

      const timingDecision = invariantF(
        { counterDeadline, bchRefundHeight },
        { unixSeconds: now, bchTipHeight },
      );
      if (!timingDecision.allowed) {
        return reply.status(422).send({
          code: 'TIMING_INVARIANT_FAILED',
          message: `Timing invariant F check failed: ${timingDecision.reason}`,
        });
      }

      // Solver BCH address & locking bytecode
      let solverBchLockingBytecode: `0x${string}` =
        '0x76a914000000000000000000000000000000000000000088ac';
      if (config.solverBchWif) {
        const solverKeys = await deriveBchKeyDetails(
          config.solverBchWif,
          config.network === 'mainnet' ? 'bitcoincash' : 'bchtest',
        );
        solverBchLockingBytecode = (
          solverKeys.lockingBytecodeHex.startsWith('0x')
            ? solverKeys.lockingBytecodeHex
            : `0x${solverKeys.lockingBytecodeHex}`
        ) as `0x${string}`;
      }

      const terms: OrderTerms = parseOrderTerms({
        version: 1,
        direction: 'COUNTER_TO_BCH',
        bchToken: link.token,
        bchTokenCategory: config.tpusdCategory.startsWith('0x')
          ? (config.tpusdCategory as `0x${string}`)
          : (`0x${config.tpusdCategory}` as `0x${string}`),
        bchTokenAmount: amountOut,
        counterAmount: amountIn,
        counterChain: 'base',
        counterNetworkId: config.baseChainId,
        counterAsset: {
          symbol: 'USDC',
          decimals: 6,
          address: config.baseUsdcAddress,
        },
        counterHtlc: config.baseHtlcAddress,
        userCounterAddress: request.userCounterAddress,
        solverCounterAddress: solverAddress,
        userBchLockingBytecode: link.recipientLockingBytecode,
        solverBchLockingBytecode,
        hashLock: request.hashLock,
        counterDeadline,
        bchRefundHeight,
        bchCarrySats: config.bchCarrySats,
        bchMaxFee: config.bchMaxFeeSats,
        quoteId: `pl-quote-${now}-${Math.random().toString(36).slice(2, 8)}`,
        quoteExpiry,
      });

      const orderId = computeOrderId(terms);
      const signature = await signOrderId(orderId, solverAccount);

      // Save order
      db.saveOrder({
        id: orderId,
        direction: 'COUNTER_TO_BCH',
        status: 'QUOTED',
        lane: request.lane,
        fastOptIn: request.fastOptIn ?? false,
        terms,
        hashLock: request.hashLock as `0x${string}`,
        needsAttention: false,
        payLinkId: link.id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      if (link.kind === 'invoice') {
        db.updatePayLinkStatus(link.id, 'reserved', orderId);
      }

      const response = {
        orderId,
        terms,
        lane: request.lane,
        signature,
        signerAddress: solverAccount.address,
      };

      return reply.status(200).send(response);
    },
  );

  // 14. POST /v1/links/:id/cancel
  app.post<{ Params: { id: string } }>(
    '/v1/links/:id/cancel',
    async (req, reply) => {
      const { id } = req.params;
      const parseResult = CancelPayLinkRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid cancel pay link payload',
          details: { issues: parseResult.error.issues },
        });
      }

      const request = parseResult.data;
      if (!config.allowMockPaylinkSignatures) {
        return reply.status(403).send({
          code: 'MOCK_SIGNATURES_DISABLED',
          message:
            'Pay-link cancellation requires real signatures; mock signatures are disabled without ALLOW_MOCK_PAYLINK_SIGNATURES=1',
        });
      }

      if (
        !verifyPayLinksSignature(
          request.owner,
          request.challenge,
          request.sig,
          config.allowMockPaylinkSignatures,
        )
      ) {
        return reply.status(400).send({
          code: 'INVALID_SIGNATURE',
          message: 'Cancel challenge is invalid',
        });
      }

      const link = db.getPayLink(id);
      if (!link) {
        return reply.status(404).send({
          code: 'LINK_NOT_FOUND',
          message: 'Pay link not found',
        });
      }

      if (
        link.recipientCashaddr.toLowerCase() !== request.owner.toLowerCase()
      ) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Only the recipient can cancel',
        });
      }

      if (link.status !== 'open') {
        return reply.status(409).send({
          code: 'LINK_CLOSED',
          message: 'Only open links can be cancelled',
        });
      }

      db.updatePayLinkStatus(link.id, 'cancelled');
      const updated = db.getPayLink(id)!;
      const validated = CancelPayLinkResponseSchema.parse(
        toPayLinkWire(updated),
      );
      return reply.status(200).send(validated);
    },
  );

  return app as unknown as FastifyInstance;
}
