import {
  CancelPayLinkRequestSchema,
  checkLimits,
  CreatePayLinkRequestSchema,
  ListPayLinksQuerySchema,
  orderId as computeOrderId,
  parseOrderTerms,
  PayLinkQuoteRequestSchema,
  quoteExactIn,
  quoteExactOut,
  QuoteRequestSchema,
  QuoteResponseSchema,
  type CancelPayLinkRequest,
  type CreatePayLinkRequest,
  type Direction,
  type HealthResponse,
  type Hex32,
  type ListPayLinksQuery,
  type OrderTerms,
  type PayLink,
  type PayLinkQuoteRequest,
  type QuoteRequest,
} from '@ferry/core';
import { keccak256, sha256, toBytes, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseBchAddress } from '../bch/address';
import { SolverError } from './errors';
import {
  createLinkId,
  MOCK_EXPIRED_LINK_ID,
  MOCK_PAY_LINK_ID,
  MOCK_RESERVED_LINK_ID,
  verifyPayLinkSignature,
  verifyPayLinksSignature,
} from '../paylink/link';
import {
  BCH_CARRY_SATS,
  BCH_MAX_FEE_SATS,
  FERRY_HTLC_ADDRESS,
  FIXED_FEE_USD_MICROS,
  FWD_BCH_REFUND_BLOCKS,
  FWD_EVM_DEADLINE_S,
  MAX_SWAP_USD_MICROS,
  MIN_SWAP_USD_MICROS,
  MOCK_BCH_SOLVER_ADDRESS,
  MOCK_BCH_USER_ADDRESS,
  PUSD_CATEGORY,
  PUSD_DECIMALS,
  QUOTE_TTL_S,
  MOCK_SOLVER_SIGNING_ADDRESS,
  REV_BCH_REFUND_BLOCKS,
  REV_EVM_DEADLINE_S,
  SPREAD_BPS,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from '../config';
import type {
  BchLockUtxo,
  OrderStatus,
  OrderTransaction,
  OrderView,
  RelayLockRequest,
  SignedQuote,
  SolverClient,
} from './types';

const solverAccount = privateKeyToAccount(
  keccak256(toBytes('ferry.mock.solver.v1')),
);

if (
  solverAccount.address.toLowerCase() !==
  MOCK_SOLVER_SIGNING_ADDRESS.toLowerCase()
) {
  throw new Error('Mock solver signing address does not match config');
}

const solverBchResult = parseBchAddress(MOCK_BCH_SOLVER_ADDRESS);
if (!solverBchResult.ok) throw new Error(solverBchResult.error);
const solverBch = solverBchResult.value;

const userBchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
if (!userBchResult.ok) throw new Error(userBchResult.error);
const userBch = userBchResult.value;

const FORWARD_PATH: readonly OrderStatus[] = [
  'USER_LOCK_SEEN',
  'USER_LOCK_FINAL',
  'SOLVER_LOCK_BROADCAST',
  'SOLVER_LOCK_SEEN',
  'SECRET_KNOWN',
  'USER_CLAIM_SEEN',
  'SOLVER_CLAIM_BROADCAST',
  'SOLVER_CLAIM_FINAL',
  'DONE',
];

const REVERSE_PATH: readonly OrderStatus[] = [
  'USER_LOCK_SEEN',
  'USER_LOCK_FINAL',
  'SOLVER_LOCK_BROADCAST',
  'SOLVER_LOCK_SEEN',
  'SECRET_KNOWN',
  'USER_CLAIM_SEEN',
  'SOLVER_CLAIM_BROADCAST',
  'SOLVER_CLAIM_FINAL',
  'DONE',
];

const REFUND_PATH: readonly OrderStatus[] = [
  'USER_LOCK_SEEN',
  'USER_LOCK_FINAL',
  'REJECTED',
];

interface MockOrder {
  readonly quote: SignedQuote;
  readonly createdAt: number;
  readonly scenario: 'happy' | 'refund';
  readonly direction: Direction;
  readonly tipHeight: number;
  status: OrderStatus;
  polls: number;
  transactions: OrderTransaction[];
}

type MutablePayLink = { -readonly [K in keyof PayLink]: PayLink[K] };

export interface MockSolverOptions {
  readonly scenario?: 'happy' | 'refund';
  readonly direction?: Direction;
  readonly bchTipHeight?: number;
  readonly quoteTtlSeconds?: number | undefined;
  readonly quoteFailure?:
    | 'rejected'
    | 'unavailable'
    | 'bch-tip'
    | 'evm-tip'
    | 'quoting-disabled'
    | 'unknown'
    | undefined;
  readonly linkIdFactory?: () => string;
}

function transaction(
  label: string,
  chain: 'base' | 'bch',
  hash: string,
): OrderTransaction {
  return { label, chain, hash };
}

function solverBchLockUtxo(): BchLockUtxo {
  return {
    txid: '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
    vout: 0,
    satoshis: BCH_CARRY_SATS,
  };
}

function userBchLockUtxo(): BchLockUtxo {
  return {
    txid: '9a3c1f5b4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c',
    vout: 1,
    satoshis: BCH_CARRY_SATS,
  };
}

function pathFor(order: MockOrder): readonly OrderStatus[] {
  return order.scenario === 'refund'
    ? REFUND_PATH
    : order.direction === 'BCH_TO_COUNTER'
      ? REVERSE_PATH
      : FORWARD_PATH;
}

export class MockSolverClient implements SolverClient {
  readonly #orders = new Map<string, MockOrder>();
  readonly #links = new Map<string, MutablePayLink>();
  readonly #linkOrders = new Map<string, string>();
  readonly #scenario: 'happy' | 'refund';
  readonly #direction: Direction;
  readonly #bchTipHeight: number;
  readonly #quoteTtlSeconds: number;
  readonly #quoteFailure:
    | 'rejected'
    | 'unavailable'
    | 'bch-tip'
    | 'evm-tip'
    | 'quoting-disabled'
    | 'unknown'
    | undefined;
  readonly #linkIdFactory: () => string;

  constructor(options: MockSolverOptions = {}) {
    this.#scenario = options.scenario ?? 'happy';
    this.#direction = options.direction ?? 'COUNTER_TO_BCH';
    this.#bchTipHeight = options.bchTipHeight ?? 329_315;
    this.#quoteTtlSeconds = options.quoteTtlSeconds ?? QUOTE_TTL_S;
    this.#quoteFailure = options.quoteFailure;
    this.#linkIdFactory = options.linkIdFactory ?? createLinkId;
    this.#seedLinks();
  }

  #seedLinks(): void {
    const now = Math.floor(Date.now() / 1000);
    const base = {
      recipientCashaddr: userBch.address,
      recipientLockingBytecode: userBch.lockingBytecode,
      token: 'PUSD' as const,
      verified: true,
      createdAt: now,
    };
    this.#links.set(MOCK_PAY_LINK_ID, {
      ...base,
      id: MOCK_PAY_LINK_ID,
      kind: 'open',
      minAmountOut: 100n,
      memo: 'Coffee and a tip',
      status: 'open',
    });
    this.#links.set(MOCK_RESERVED_LINK_ID, {
      ...base,
      id: MOCK_RESERVED_LINK_ID,
      kind: 'invoice',
      amountOut: 4_000n,
      memo: 'Kitchen order #1042',
      status: 'reserved',
      expiresAt: now + 86_400,
    });
    this.#links.set(MOCK_EXPIRED_LINK_ID, {
      ...base,
      id: MOCK_EXPIRED_LINK_ID,
      kind: 'invoice',
      amountOut: 2_000n,
      memo: 'Expired invoice',
      status: 'open',
      expiresAt: now - 60,
    });
  }

  #expire(link: MutablePayLink): void {
    if (
      link.expiresAt !== undefined &&
      link.expiresAt <= Math.floor(Date.now() / 1000) &&
      (link.status === 'open' || link.status === 'reserved')
    ) {
      link.status = 'expired';
    }
  }

  #link(id: string): MutablePayLink {
    const link = this.#links.get(id);
    if (!link) throw new Error('LINK_NOT_FOUND: Pay link not found');
    this.#expire(link);
    return link;
  }

  #cloneLink(link: MutablePayLink): PayLink {
    return { ...link };
  }

  #syncLink(order: MockOrder): void {
    const linkId = this.#linkOrders.get(order.quote.orderId);
    if (!linkId) return;
    const link = this.#links.get(linkId);
    if (!link) return;
    if (order.status === 'DONE') {
      link.status = 'paid';
      return;
    }
    if (order.status === 'REJECTED' || order.status === 'EXPIRED') {
      if (link.status === 'reserved') {
        link.status = 'open';
        delete link.orderId;
      }
    }
  }

  async getHealth(): Promise<HealthResponse> {
    const now = Math.floor(Date.now() / 1_000);
    return {
      ok: true,
      quotingEnabled: true,
      quoting: true,
      bchTip: {
        height: this.#bchTipHeight,
        ageSeconds: 0,
        stale: false,
        quorum: true,
      },
      counterTips: {
        base: { height: 1, ageSeconds: 0, stale: false },
      },
      inventory: [],
      timestamp: now,
    };
  }

  async quote(input: QuoteRequest): Promise<SignedQuote> {
    if (this.#quoteFailure === 'unavailable') {
      throw new SolverError('UNREACHABLE', 'connect ECONNREFUSED');
    }
    if (this.#quoteFailure === 'rejected') {
      throw new SolverError(
        'INSUFFICIENT_INVENTORY',
        'The solver cannot cover this amount right now',
      );
    }
    if (this.#quoteFailure === 'bch-tip') {
      throw new SolverError(
        'BCH_TIP_UNHEALTHY',
        'BCH quorum is unhealthy or tip is unknown/stale; quoting disabled',
      );
    }
    if (this.#quoteFailure === 'evm-tip') {
      throw new SolverError(
        'EVM_TIP_UNHEALTHY',
        'Base tip is stale or unavailable; quoting disabled',
      );
    }
    if (this.#quoteFailure === 'quoting-disabled') {
      throw new SolverError('QUOTING_DISABLED', 'Quoting is paused');
    }
    if (this.#quoteFailure === 'unknown') {
      throw new SolverError(
        'UNKNOWN',
        'A future solver failure',
        400,
        'FUTURE_CODE',
      );
    }
    const request = QuoteRequestSchema.parse(input);
    if (request.bchToken !== 'PUSD') {
      throw new Error('Only tPUSD is enabled');
    }
    if (request.counterChain !== 'base' || request.counterSymbol !== 'USDC') {
      throw new Error('Only Base USDC is enabled');
    }
    const reverse = request.direction === 'BCH_TO_COUNTER';
    const inputDecimals = reverse ? PUSD_DECIMALS : USDC_DECIMALS;
    if (
      !checkLimits(request.amountIn, inputDecimals, {
        minUsdMicros: MIN_SWAP_USD_MICROS,
        maxUsdMicros: MAX_SWAP_USD_MICROS,
      })
    ) {
      throw new Error('Amount is outside the swap limits');
    }
    if (request.lane === 'fast' && request.fastOptIn !== true) {
      throw new Error('Fast lane requires explicit opt-in');
    }
    const fastLaneMax = reverse ? 2_500n : 25_000_000n;
    if (request.lane === 'fast' && request.amountIn > fastLaneMax) {
      throw new Error('Fast lane is limited to $25');
    }

    const pricingPolicy = {
      spreadBps: SPREAD_BPS,
      fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
    };
    const bchTokenAmount = reverse
      ? request.amountIn
      : quoteExactIn(
          request.amountIn,
          USDC_DECIMALS,
          PUSD_DECIMALS,
          pricingPolicy,
        );
    const counterAmount = reverse
      ? quoteExactIn(
          request.amountIn,
          PUSD_DECIMALS,
          USDC_DECIMALS,
          pricingPolicy,
        )
      : request.amountIn;
    if (bchTokenAmount <= 0n || counterAmount <= 0n) {
      throw new Error('Amount is too small after fees');
    }

    const now = Math.floor(Date.now() / 1000);
    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: request.direction,
      bchToken: 'PUSD',
      bchTokenCategory: PUSD_CATEGORY,
      bchTokenAmount,
      counterAmount,
      counterChain: 'base',
      counterNetworkId: 84_532,
      counterAsset: {
        symbol: 'USDC',
        decimals: USDC_DECIMALS,
        address: USDC_ADDRESS,
      },
      counterHtlc: FERRY_HTLC_ADDRESS,
      userCounterAddress: request.userCounterAddress,
      solverCounterAddress: solverAccount.address,
      userBchLockingBytecode: request.userBchLockingBytecode,
      solverBchLockingBytecode: solverBch.lockingBytecode,
      hashLock: request.hashLock,
      counterDeadline:
        now + (reverse ? REV_EVM_DEADLINE_S : FWD_EVM_DEADLINE_S),
      bchRefundHeight:
        this.#bchTipHeight +
        (reverse ? REV_BCH_REFUND_BLOCKS : FWD_BCH_REFUND_BLOCKS),
      bchCarrySats: BCH_CARRY_SATS,
      bchMaxFee: BCH_MAX_FEE_SATS,
      quoteId: `mock-quote-${now}`,
      quoteExpiry: now + this.#quoteTtlSeconds,
    });
    const id = computeOrderId(terms);
    const signature = await solverAccount.signMessage({
      message: { raw: id },
    });
    const quote: SignedQuote = {
      ...QuoteResponseSchema.parse({
        orderId: id,
        terms,
        lane: request.lane,
        signature,
        signerAddress: solverAccount.address,
      }),
      bchTipHeight: this.#bchTipHeight,
    };
    this.#orders.set(id, {
      quote,
      createdAt: now,
      scenario: this.#scenario,
      direction: request.direction,
      tipHeight: this.#bchTipHeight,
      status: 'QUOTED',
      polls: 0,
      transactions: [],
    });
    return quote;
  }

  async createPayLink(input: CreatePayLinkRequest): Promise<PayLink> {
    const request = CreatePayLinkRequestSchema.parse(input);
    const now = Math.floor(Date.now() / 1000);
    if (request.expiresAt !== undefined && request.expiresAt <= now) {
      throw new Error('LINK_EXPIRED: Expiry must be in the future');
    }
    let id = this.#linkIdFactory();
    while (this.#links.has(id)) id = this.#linkIdFactory();
    const verified = request.verification
      ? verifyPayLinkSignature(
          request.verification.challenge,
          request.verification.signature,
          request.recipientLockingBytecode,
        )
      : false;
    const link: MutablePayLink = {
      id,
      kind: request.kind,
      recipientCashaddr: request.recipientCashaddr,
      recipientLockingBytecode: request.recipientLockingBytecode,
      token: request.token,
      ...(request.amountOut !== undefined
        ? { amountOut: request.amountOut }
        : {}),
      ...(request.minAmountOut !== undefined
        ? { minAmountOut: request.minAmountOut }
        : {}),
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      ...(request.reference !== undefined
        ? { reference: request.reference }
        : {}),
      ...(request.expiresAt !== undefined
        ? { expiresAt: request.expiresAt }
        : {}),
      verified,
      status: 'open',
      createdAt: now,
    };
    this.#links.set(id, link);
    return this.#cloneLink(link);
  }

  async getPayLink(id: string): Promise<PayLink> {
    return this.#cloneLink(this.#link(id));
  }

  async quotePayLink(
    id: string,
    input: PayLinkQuoteRequest,
  ): Promise<SignedQuote> {
    const request = PayLinkQuoteRequestSchema.parse(input);
    const link = this.#link(id);
    if (link.status === 'reserved') {
      const previous = link.orderId ? this.#orders.get(link.orderId) : null;
      const samePayer =
        previous?.quote.terms.userCounterAddress.toLowerCase() ===
        request.userCounterAddress.toLowerCase();
      if (!samePayer) {
        throw new Error('LINK_RESERVED: This invoice is being paid');
      }
    }
    if (link.status === 'paid') {
      throw new Error('LINK_CLOSED: This pay link is already paid');
    }
    if (link.status === 'expired') {
      throw new Error('LINK_EXPIRED: This pay link has expired');
    }
    if (link.status === 'cancelled') {
      throw new Error('LINK_CLOSED: This pay link was cancelled');
    }
    if (link.token !== 'PUSD') throw new Error('Only tPUSD is enabled');
    if (request.counterChain !== 'base' || request.counterSymbol !== 'USDC') {
      throw new Error('Only Base USDC is enabled');
    }
    if (request.lane === 'fast' && request.fastOptIn !== true) {
      throw new Error('Fast lane requires explicit opt-in');
    }
    const amountOut =
      link.kind === 'invoice' ? link.amountOut : request.amountOut;
    if (amountOut === undefined || amountOut <= 0n) {
      throw new Error('Enter an amount above zero');
    }
    if (link.minAmountOut !== undefined && amountOut < link.minAmountOut) {
      throw new Error('Amount is below this link minimum');
    }
    const pricingPolicy = {
      spreadBps: SPREAD_BPS,
      fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
    };
    const amountIn = quoteExactOut(
      amountOut,
      USDC_DECIMALS,
      PUSD_DECIMALS,
      pricingPolicy,
    );
    if (
      !checkLimits(amountIn, USDC_DECIMALS, {
        minUsdMicros: MIN_SWAP_USD_MICROS,
        maxUsdMicros: MAX_SWAP_USD_MICROS,
      })
    ) {
      throw new Error('Amount is outside the swap limits');
    }
    if (request.lane === 'fast' && amountIn > 25_000_000n) {
      throw new Error('Fast lane is limited to $25');
    }

    const now = Math.floor(Date.now() / 1000);
    const quoteExpiry =
      link.expiresAt === undefined
        ? now + this.#quoteTtlSeconds
        : Math.min(now + this.#quoteTtlSeconds, link.expiresAt);
    if (quoteExpiry <= now) {
      throw new Error('LINK_EXPIRED: This pay link has expired');
    }
    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: link.token,
      bchTokenCategory: PUSD_CATEGORY,
      bchTokenAmount: amountOut,
      counterAmount: amountIn,
      counterChain: 'base',
      counterNetworkId: 84_532,
      counterAsset: {
        symbol: 'USDC',
        decimals: USDC_DECIMALS,
        address: USDC_ADDRESS,
      },
      counterHtlc: FERRY_HTLC_ADDRESS,
      userCounterAddress: request.userCounterAddress,
      solverCounterAddress: solverAccount.address,
      userBchLockingBytecode: link.recipientLockingBytecode,
      solverBchLockingBytecode: solverBch.lockingBytecode,
      hashLock: request.hashLock,
      counterDeadline: now + FWD_EVM_DEADLINE_S,
      bchRefundHeight: this.#bchTipHeight + FWD_BCH_REFUND_BLOCKS,
      bchCarrySats: BCH_CARRY_SATS,
      bchMaxFee: BCH_MAX_FEE_SATS,
      quoteId: `mock-link-quote-${now}`,
      quoteExpiry,
    });
    const orderId = computeOrderId(terms);
    const signature = await solverAccount.signMessage({
      message: { raw: orderId },
    });
    const quote: SignedQuote = {
      ...QuoteResponseSchema.parse({
        orderId,
        terms,
        lane: request.lane,
        signature,
        signerAddress: solverAccount.address,
      }),
      bchTipHeight: this.#bchTipHeight,
    };
    this.#orders.set(orderId, {
      quote,
      createdAt: now,
      scenario: this.#scenario,
      direction: 'COUNTER_TO_BCH',
      tipHeight: this.#bchTipHeight,
      status: 'QUOTED',
      polls: 0,
      transactions: [],
    });
    link.orderId = orderId;
    this.#linkOrders.set(orderId, link.id);
    if (link.kind === 'invoice') link.status = 'reserved';
    return quote;
  }

  async listPayLinks(input: ListPayLinksQuery): Promise<readonly PayLink[]> {
    const query = ListPayLinksQuerySchema.parse(input);
    if (!verifyPayLinksSignature(query.owner, query.challenge, query.sig)) {
      throw new Error('INVALID_SIGNATURE: Link list challenge is invalid');
    }
    return [...this.#links.values()]
      .filter((link) => {
        this.#expire(link);
        return link.recipientCashaddr === query.owner;
      })
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((link) => this.#cloneLink(link));
  }

  async cancelPayLink(
    id: string,
    input: CancelPayLinkRequest,
  ): Promise<PayLink> {
    const request = CancelPayLinkRequestSchema.parse(input);
    if (
      !verifyPayLinksSignature(request.owner, request.challenge, request.sig)
    ) {
      throw new Error('INVALID_SIGNATURE: Cancel challenge is invalid');
    }
    const link = this.#link(id);
    if (link.recipientCashaddr !== request.owner) {
      throw new Error('UNAUTHORIZED: Only the recipient can cancel');
    }
    if (link.status !== 'open') {
      throw new Error('LINK_CLOSED: Only open links can be cancelled');
    }
    link.status = 'cancelled';
    return this.#cloneLink(link);
  }

  async relayLock(request: RelayLockRequest): Promise<{ txHash: string }> {
    const order = this.#orders.get(request.orderId);
    if (!order) throw new Error('Unknown order');
    if (order.direction !== 'COUNTER_TO_BCH') {
      throw new Error('relay-lock is only used in the forward direction');
    }
    if (order.status !== 'QUOTED') throw new Error('Order is not quotable');
    if (!request.permitSignature.startsWith('0x')) {
      throw new Error('Permit signature is missing');
    }
    if (!request.intentSignature.startsWith('0x')) {
      throw new Error('Intent signature is missing');
    }
    if (!Number.isSafeInteger(request.permitDeadline)) {
      throw new Error('Permit deadline is missing');
    }

    order.status = 'USER_LOCK_SEEN';
    order.transactions.push(
      transaction('Base lock', 'base', `0x${'11'.repeat(32)}`),
    );
    return { txHash: `0x${'11'.repeat(32)}` };
  }

  async getOrder(id: Hex32): Promise<OrderView> {
    let order = this.#orders.get(id);
    if (!order) {
      if (this.#scenario === 'refund') {
        order = this.#refundFixture(id);
      } else {
        throw new Error('Order not found');
      }
    }
    this.#advance(order);
    return this.#view(id, order);
  }

  async submitSecret(id: Hex32, secret: Hex32): Promise<void> {
    const order = this.#orders.get(id);
    if (!order) throw new Error('Unknown order');
    if (order.direction !== 'COUNTER_TO_BCH') {
      throw new Error('submit-secret is only used in the forward direction');
    }
    if (order.scenario !== 'happy') throw new Error('Order cannot reveal');
    if (order.status !== 'SOLVER_LOCK_SEEN') {
      throw new Error('The solver lock is not ready');
    }
    if (sha256(secret) !== order.quote.terms.hashLock) {
      throw new Error('Secret does not match the hash lock');
    }
    order.status = 'SECRET_KNOWN';
    order.polls = FORWARD_PATH.indexOf('SECRET_KNOWN') + 1;
  }

  async relayClaim(id: Hex32, secret: Hex32): Promise<void> {
    const order = this.#orders.get(id);
    if (!order) throw new Error('Unknown order');
    if (order.direction !== 'BCH_TO_COUNTER') {
      throw new Error('relay-claim is only used in the reverse direction');
    }
    if (order.scenario !== 'happy') throw new Error('Order cannot reveal');
    if (order.status !== 'SOLVER_LOCK_SEEN') {
      throw new Error('The solver USDC lock is not ready');
    }
    if (sha256(secret) !== order.quote.terms.hashLock) {
      throw new Error('Secret does not match the hash lock');
    }
    order.status = 'SECRET_KNOWN';
    order.polls = REVERSE_PATH.indexOf('SECRET_KNOWN') + 1;
  }

  #advance(order: MockOrder): void {
    order.polls += 1;
    const path = pathFor(order);
    const index = Math.min(order.polls - 1, path.length - 1);
    const next = path[index];
    if (next) order.status = next;
    this.#syncLink(order);

    if (next === 'USER_LOCK_SEEN' && order.transactions.length === 0) {
      order.transactions.push(
        order.direction === 'BCH_TO_COUNTER'
          ? transaction(
              'BCH lock',
              'bch',
              '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
            )
          : transaction('Base lock', 'base', `0x${'11'.repeat(32)}`),
      );
    }
    if (next === 'SOLVER_LOCK_BROADCAST') {
      order.transactions.push(
        order.direction === 'BCH_TO_COUNTER'
          ? transaction('Base lock', 'base', `0x${'22'.repeat(32)}`)
          : transaction(
              'BCH lock',
              'bch',
              '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
            ),
      );
    }
    if (next === 'USER_CLAIM_SEEN') {
      order.transactions.push(
        order.direction === 'BCH_TO_COUNTER'
          ? transaction('Base claim', 'base', `0x${'33'.repeat(32)}`)
          : transaction(
              'BCH claim',
              'bch',
              '9c2a1f5b4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c',
            ),
      );
    }
    if (next === 'SOLVER_CLAIM_BROADCAST') {
      order.transactions.push(
        order.direction === 'BCH_TO_COUNTER'
          ? transaction(
              'BCH claim',
              'bch',
              '9c2a1f5b4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c',
            )
          : transaction('Base claim', 'base', `0x${'22'.repeat(32)}`),
      );
    }
  }

  #view(id: Hex32, order: MockOrder): OrderView {
    const reverse = order.direction === 'BCH_TO_COUNTER';
    const hasSolverLock =
      order.status === 'SOLVER_LOCK_BROADCAST' ||
      order.status === 'SOLVER_LOCK_SEEN' ||
      order.status === 'SECRET_KNOWN' ||
      order.status === 'USER_CLAIM_SEEN' ||
      order.status === 'SOLVER_CLAIM_BROADCAST' ||
      order.status === 'SOLVER_CLAIM_FINAL' ||
      order.status === 'DONE';

    return {
      orderId: id,
      status: order.status,
      terms: order.quote.terms,
      lane: order.quote.lane,
      bchTipHeight: order.tipHeight,
      bchTipError: null,
      updatedAt: Math.floor(Date.now() / 1000),
      transactions: order.transactions,
      bchLockUtxo: reverse
        ? order.status === 'QUOTED'
          ? null
          : userBchLockUtxo()
        : hasSolverLock
          ? solverBchLockUtxo()
          : null,
      claimAvailable: order.status === 'SOLVER_LOCK_SEEN',
      refundAvailable: !reverse && order.status === 'REJECTED',
      bchRefundAvailable:
        reverse &&
        (order.status === 'REJECTED' || order.status === 'EXPIRED') &&
        order.tipHeight >= order.quote.terms.bchRefundHeight,
    };
  }

  #refundFixture(id: Hex32): MockOrder {
    const now = Math.floor(Date.now() / 1000);
    const reverse = this.#direction === 'BCH_TO_COUNTER';
    const terms = parseOrderTerms({
      version: 1,
      direction: this.#direction,
      bchToken: 'PUSD',
      bchTokenCategory: PUSD_CATEGORY,
      bchTokenAmount: reverse ? 1_000n : 991n,
      counterAmount: reverse ? 9_940_000n : 10_000_000n,
      counterChain: 'base',
      counterNetworkId: 84_532,
      counterAsset: {
        symbol: 'USDC',
        decimals: USDC_DECIMALS,
        address: USDC_ADDRESS,
      },
      counterHtlc: FERRY_HTLC_ADDRESS,
      userCounterAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
      solverCounterAddress: solverAccount.address,
      userBchLockingBytecode:
        '0x76a914000000000000000000000000000000000000000088ac',
      solverBchLockingBytecode: solverBch.lockingBytecode,
      hashLock: `0x${'33'.repeat(32)}`,
      counterDeadline:
        now + (reverse ? REV_EVM_DEADLINE_S : FWD_EVM_DEADLINE_S),
      bchRefundHeight:
        this.#bchTipHeight +
        (reverse ? REV_BCH_REFUND_BLOCKS : FWD_BCH_REFUND_BLOCKS),
      bchCarrySats: BCH_CARRY_SATS,
      bchMaxFee: BCH_MAX_FEE_SATS,
      quoteId: reverse ? 'mock-reverse-refund' : 'mock-refund',
      quoteExpiry: now + this.#quoteTtlSeconds,
    });
    const quote: SignedQuote = {
      terms,
      orderId: id,
      signature: `0x${'44'.repeat(65)}`,
      signerAddress: solverAccount.address,
      bchTipHeight: this.#bchTipHeight,
      lane: 'safe',
    };
    return {
      quote,
      createdAt: now,
      scenario: 'refund',
      direction: this.#direction,
      tipHeight: reverse ? terms.bchRefundHeight : this.#bchTipHeight,
      status: 'REJECTED',
      polls: REFUND_PATH.length,
      transactions: [
        reverse
          ? transaction(
              'BCH lock',
              'bch',
              '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
            )
          : transaction('Base lock', 'base', `0x${'11'.repeat(32)}`),
      ],
    };
  }
}

export function createMockSolverClient(
  options: MockSolverOptions = {},
): SolverClient {
  return new MockSolverClient(options);
}

export const MOCK_SOLVER_ADDRESS: Address = solverAccount.address;
