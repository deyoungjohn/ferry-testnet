import {
  invariantF,
  invariantR,
  orderId as computeOrderId,
  quoteExactIn,
  verifyOrderSignature,
  type Hex,
  type OrderTerms,
  type PricingPolicy,
  type QuoteRequest,
} from '@ferry/core';
import type { Address } from 'viem';
import type { SignedQuote } from './types';

export interface TermsCheckConfig {
  readonly counterChain: 'base';
  readonly counterNetworkId: number;
  readonly counterSymbol: 'USDC' | 'USDT';
  readonly counterAssetAddress: string;
  readonly counterAssetDecimals: number;
  readonly counterHtlc: string;
  readonly bchToken: 'PUSD' | 'MUSD';
  readonly bchTokenCategory: string;
  readonly solverCounterAddress: string;
  readonly solverBchLockingBytecode: string;
  readonly bchTipHeight: number;
  readonly bchCarrySats: bigint;
  readonly bchMaxFee: bigint;
  readonly pricingPolicy: PricingPolicy;
  readonly nowSeconds: number;
  readonly maxQuoteFutureSeconds: number;
  readonly maxCounterDeadlineSeconds: number;
  readonly minBchRefundBlocks: number;
  readonly maxBchRefundBlocks: number;
}

export async function verifySignedQuote(
  quote: SignedQuote,
  trustedSigner: Address,
): Promise<boolean> {
  if (quote.signerAddress.toLowerCase() !== trustedSigner.toLowerCase()) {
    return false;
  }
  const id = computeOrderId(quote.terms);
  if (id !== quote.orderId) return false;
  return verifyOrderSignature(id, quote.signature, trustedSigner);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requireEqual(
  field: string,
  actual: string | number | bigint,
  expected: string | number | bigint,
): void {
  if (actual !== expected) {
    throw new Error(`Quote ${field} does not match the request`);
  }
}

function requireHex(
  field: string,
  actual: Hex | string,
  expected: Hex | string,
): void {
  if (!sameHex(actual, expected)) {
    throw new Error(`Quote ${field} does not match the request`);
  }
}

export function assertTermsMatchRequest(
  terms: OrderTerms,
  request: QuoteRequest,
  config: TermsCheckConfig,
): void {
  requireEqual('direction', terms.direction, request.direction);
  requireEqual('counter chain', terms.counterChain, request.counterChain);
  requireEqual(
    'counter network',
    terms.counterNetworkId,
    config.counterNetworkId,
  );
  requireEqual(
    'counter asset symbol',
    terms.counterAsset.symbol,
    request.counterSymbol,
  );
  requireHex(
    'counter asset address',
    terms.counterAsset.address,
    config.counterAssetAddress,
  );
  requireEqual(
    'counter asset decimals',
    terms.counterAsset.decimals,
    config.counterAssetDecimals,
  );
  requireHex('counter HTLC', terms.counterHtlc, config.counterHtlc);
  requireHex(
    'user counter address',
    terms.userCounterAddress,
    request.userCounterAddress,
  );
  requireHex(
    'user BCH locking bytecode',
    terms.userBchLockingBytecode,
    request.userBchLockingBytecode,
  );
  requireHex('hash lock', terms.hashLock, request.hashLock);
  requireEqual('BCH token', terms.bchToken, config.bchToken);
  requireHex(
    'BCH token category',
    terms.bchTokenCategory,
    config.bchTokenCategory,
  );
  requireHex(
    'solver counter address',
    terms.solverCounterAddress,
    config.solverCounterAddress,
  );
  requireHex(
    'solver BCH locking bytecode',
    terms.solverBchLockingBytecode,
    config.solverBchLockingBytecode,
  );

  if (terms.direction === 'COUNTER_TO_BCH') {
    requireEqual('counter amount', terms.counterAmount, request.amountIn);
  } else {
    requireEqual('BCH token amount', terms.bchTokenAmount, request.amountIn);
  }

  const expectedOutput =
    terms.direction === 'COUNTER_TO_BCH'
      ? quoteExactIn(
          request.amountIn,
          config.counterAssetDecimals,
          2,
          config.pricingPolicy,
        )
      : quoteExactIn(
          request.amountIn,
          2,
          config.counterAssetDecimals,
          config.pricingPolicy,
        );
  const actualOutput =
    terms.direction === 'COUNTER_TO_BCH'
      ? terms.bchTokenAmount
      : terms.counterAmount;
  if (actualOutput < expectedOutput) {
    throw new Error('Quote payout is worse than the published pricing policy');
  }

  requireEqual('BCH carry', terms.bchCarrySats, config.bchCarrySats);
  if (terms.bchMaxFee > config.bchMaxFee) {
    throw new Error('Quote BCH max fee exceeds the configured limit');
  }

  const now = config.nowSeconds;
  if (terms.quoteExpiry <= now) {
    throw new Error('Quote is already expired');
  }
  if (terms.quoteExpiry > now + config.maxQuoteFutureSeconds) {
    throw new Error('Quote expiry is too far in the future');
  }
  if (terms.counterDeadline <= now) {
    throw new Error('Quote counter deadline is already expired');
  }
  if (terms.counterDeadline > now + config.maxCounterDeadlineSeconds) {
    throw new Error('Quote counter deadline is too far in the future');
  }
  const refundBlocks = terms.bchRefundHeight - config.bchTipHeight;
  if (refundBlocks < config.minBchRefundBlocks) {
    throw new Error('Quote BCH refund height is too soon');
  }
  if (refundBlocks > config.maxBchRefundBlocks) {
    throw new Error('Quote BCH refund height is too far away');
  }
}

export function assertTimingInvariant(
  terms: OrderTerms,
  config: Pick<TermsCheckConfig, 'bchTipHeight' | 'nowSeconds'>,
): void {
  const start = {
    unixSeconds: config.nowSeconds,
    bchTipHeight: config.bchTipHeight,
  };
  const decision =
    terms.direction === 'BCH_TO_COUNTER'
      ? invariantR(terms, start)
      : invariantF(terms, start);
  if (!decision.allowed) {
    throw new Error(
      `Quote ${terms.direction === 'BCH_TO_COUNTER' ? 'reverse' : 'forward'} timing invariant failed: ${decision.reason}`,
    );
  }
}

export function isQuoteExpired(
  terms: OrderTerms,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return nowSeconds >= terms.quoteExpiry;
}
