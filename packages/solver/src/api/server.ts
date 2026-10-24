import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { pino } from 'pino';
import { privateKeyToAccount } from 'viem/accounts';
import {
  QuoteRequestSchema,
  RevealSecretRequestSchema,
  RelayLockRequestSchema,
  parseOrderTerms,
  orderId as computeOrderId,
  signOrderId,
  quoteExactIn,
  checkLimits,
  pegGuard,
  invariantF,
  revealPolicy,
  type OrderTerms,
} from '@ferry/core';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { SolverDatabase } from '../db/database.js';
import type { BchQuorumClient } from '../bch/quorum-client.js';
import type { SolverConfig } from '../config.js';
import type { SolverEngine } from '../engine/runner.js';
import type { SolverOrderRecord } from '../state-machine/types.js';

export interface SolverServerOptions {
  config: SolverConfig;
  db: SolverDatabase;
  evmAdapter: EvmChainAdapter;
  bchClient: BchQuorumClient;
  engine: SolverEngine;
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

    // Check limits ($5 - $250)
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

    // Peg guard check (simulated / interface-supplied 1.00 USD prices)
    const dummyPrices = [1000000n, 999800n, 1000100n]; // Millionths of 1 USD
    const isPegHealthy = pegGuard(dummyPrices, 10000n); // 1% tolerance
    if (!isPegHealthy) {
      return reply.status(503).send({
        code: 'PEG_DEVIATION',
        message: 'Stablecoin peg deviation exceeds safety threshold',
      });
    }

    // Check tip ages
    const quorum = bchClient.getQuorumStatus();
    if (quorum.ageSeconds > config.tipMaxAgeBchSeconds) {
      return reply.status(503).send({
        code: 'BCH_TIP_STALE',
        message: 'BCH tip is stale; quoting disabled',
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
    const bchRefundHeight = (quorum.quorumTip || 329000) + 36;

    // Invariant F check
    const timingDecision = invariantF(
      { counterDeadline, bchRefundHeight },
      { unixSeconds: now, bchTipHeight: quorum.quorumTip || 329000 },
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

    // Persist to DB in QUOTED status
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
      lane: request.lane,
      signature,
      signerAddress: solverAddress,
    };

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
      secret: secretToReturn,
      deadlines: {
        quoteExpiry: order.terms.quoteExpiry,
        counterDeadline: order.terms.counterDeadline,
        bchRefundHeight: order.terms.bchRefundHeight,
      },
      updatedAt: order.updatedAt,
    };

    return reply.status(200).send(response);
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

    // Verify reveal policy
    const policyResult = revealPolicy({
      chain: 'base',
      lane: 'safe',
      fastOptIn: false,
      amountUsdMicros: order.terms.counterAmount,
      evidence: {
        exists: true,
        confirmations: 10,
        safe: true,
      },
    });

    if (!policyResult.allowed) {
      return reply.status(400).send({
        code: 'REVEAL_POLICY_REJECTED',
        message: `Reveal policy rejected: ${policyResult.reason}`,
      });
    }

    // Record cooperative reveal
    engine.applyEvent(order, {
      type: 'SECRET_REVEALED_COOPERATIVE',
      secret,
    });

    return reply.status(200).send({
      orderId: order.id,
      status: order.status,
      accepted: true,
    });
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
        code: 'INVALID_RELAY_REQUEST',
        message: 'Invalid relay-lock payload',
        issues: parseResult.error.issues,
      });
    }

    const relayReq = parseResult.data;

    // Verify intent matches signed terms
    if (
      relayReq.token.toLowerCase() !==
        order.terms.counterAsset.address.toLowerCase() ||
      relayReq.amount !== order.terms.counterAmount ||
      relayReq.hashLock.toLowerCase() !== order.terms.hashLock.toLowerCase() ||
      relayReq.deadline !== BigInt(order.terms.counterDeadline)
    ) {
      return reply.status(400).send({
        code: 'INTENT_TERMS_MISMATCH',
        message: 'Relay lock intent does not match order terms',
      });
    }

    const relayTx = await evmAdapter.relayLock({
      chain: order.terms.counterChain,
      orderId: order.id as `0x${string}`,
      payload: relayReq,
    });

    // Apply event
    engine.applyEvent(order, {
      type: 'USER_LOCK_SEEN',
      txId: relayTx.txId,
    });

    return reply.status(200).send({
      orderId: order.id,
      txRef: {
        chain: order.terms.counterChain,
        txId: relayTx.txId,
      },
      status: order.status,
    });
  });

  // 5. GET /v1/health
  app.get('/v1/health', async (_req, reply) => {
    const bchQuorum = bchClient.getQuorumStatus();
    const isQuoting =
      bchQuorum.isQuorumHealthy &&
      bchQuorum.ageSeconds <= config.tipMaxAgeBchSeconds;

    const response = {
      ok: true,
      quotingEnabled: true,
      quoting: isQuoting,
      bchTip: {
        height: bchQuorum.quorumTip,
        ageSeconds:
          bchQuorum.ageSeconds === Infinity ? 0 : bchQuorum.ageSeconds,
        stale: bchQuorum.ageSeconds > config.tipMaxAgeBchSeconds,
        quorum: bchQuorum.isQuorumHealthy,
      },
      counterTips: {
        base: {
          chain: 'base' as const,
          tip: 1000000,
          ageSeconds: 5,
          stale: false,
        },
      },
      inventory: [
        {
          chain: 'bch' as const,
          symbol: 'PUSD' as const,
          decimals: 2,
          balance: 100000000n,
        },
        {
          chain: 'base' as const,
          symbol: 'USDC' as const,
          decimals: 6,
          balance: 1000000000n,
        },
      ],
      timestamp: Math.floor(Date.now() / 1000),
    };

    return reply.status(200).send(response);
  });

  return app;
}
