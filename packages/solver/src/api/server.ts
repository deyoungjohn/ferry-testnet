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
  HealthResponseSchema,
  parseOrderTerms,
  orderId as computeOrderId,
  signOrderId,
  quoteExactIn,
  checkLimits,
  pegGuard,
  invariantF,
  revealPolicy,
} from '@ferry/core';
import type { OrderTerms } from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import type { SolverConfig } from '../config.js';
import type { SolverEngine } from '../engine/runner.js';
import type { SolverOrderRecord } from '../state-machine/types.js';
import {
  type PriceSource,
  TestnetStubPriceSource,
} from '../pricing/price-source.js';

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

    // Check limits
    const amountIn = request.amountIn;
    const isWithinLimits = checkLimits(amountIn, 6, {
      minUsdMicros: config.minSwapUsdMicros,
      maxUsdMicros: config.maxSwapUsdMicros,
    });
    if (!isWithinLimits) {
      return reply.status(400).send({
        code: 'AMOUNT_OUT_OF_BOUNDS',
        message: 'Requested swap amount exceeds bounds',
      });
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
    const bchTokenAmount = quoteExactIn(amountIn, 6, 2, {
      spreadBps: config.spreadBps,
      fixedFeeUsdMicros: config.fixedFeeUsdMicros,
    });

    const now = Math.floor(Date.now() / 1000);
    const quoteExpiry = now + 120; // 2 minutes
    const counterDeadline = now + 86400; // 24 hours
    const bchRefundHeight = quorum.quorumTip + 36;

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

    // Construct terms
    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: request.direction,
      bchToken: request.bchToken,
      bchTokenCategory: config.tpusdCategory.startsWith('0x')
        ? (config.tpusdCategory as `0x${string}`)
        : (`0x${config.tpusdCategory}` as `0x${string}`),
      bchTokenAmount,
      counterAmount: amountIn,
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
      solverBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac',
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

    const bchLock = order.solverLockTxId
      ? {
          txid: order.solverLockTxId,
          vout: 0,
          satoshis: order.terms.bchCarrySats,
        }
      : undefined;

    const response = {
      orderId: order.id,
      status: order.status,
      lane: 'safe',
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
    const lockId = evmAdapter.lockId(
      order.terms.userCounterAddress as `0x${string}`,
      order.terms.hashLock,
    );
    const evmLock = await evmAdapter.getLock(lockId);
    let confs = 0;
    let safeFinal = false;
    if (evmLock.status === 'locked') {
      safeFinal = await evmAdapter.isFinal(evmLock.lockTx, 'safe');
      confs = safeFinal ? config.evmConfs : 1;
    }

    const policyResult = revealPolicy({
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

    // Verify permit deadline hasn't expired
    const now = Math.floor(Date.now() / 1000);
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

  // 5. GET /v1/health
  app.get('/v1/health', async (_req, reply) => {
    const quorum = bchClient.getQuorumStatus();
    const stale = quorum.ageSeconds > config.tipMaxAgeBchSeconds;
    const isQuorumOk = quorum.isQuorumHealthy && quorum.quorumTip > 0;
    const isBchHealthy = isQuorumOk && !stale;

    const response = {
      ok: isBchHealthy && config.quotingEnabled,
      quotingEnabled: config.quotingEnabled,
      quoting: config.quotingEnabled && isBchHealthy,
      bchTip: {
        height: quorum.quorumTip,
        ageSeconds: Math.max(
          0,
          quorum.ageSeconds === Infinity ? 0 : quorum.ageSeconds,
        ),
        stale,
        quorum: quorum.isQuorumHealthy,
      },
      counterTips: {
        base: {
          height: 1,
          ageSeconds: 0,
          stale: false,
        },
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

  return app as unknown as FastifyInstance;
}
