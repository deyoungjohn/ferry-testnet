import {
  checkLimits,
  orderId as computeOrderId,
  parseOrderTerms,
  quoteExactIn,
  QuoteRequestSchema,
  QuoteResponseSchema,
  type Hex32,
  type OrderTerms,
  type QuoteRequest,
} from '@ferry/core';
import { keccak256, toBytes, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseBchAddress } from '../bch/address';
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
  PUSD_CATEGORY,
  QUOTE_TTL_S,
  SOLVER_SIGNING_ADDRESS,
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
  solverAccount.address.toLowerCase() !== SOLVER_SIGNING_ADDRESS.toLowerCase()
) {
  throw new Error('Mock solver signing address does not match config');
}

const solverBchResult = parseBchAddress(MOCK_BCH_SOLVER_ADDRESS);
if (!solverBchResult.ok) throw new Error(solverBchResult.error);
const solverBch = solverBchResult.value;

const HAPPY_PATH: readonly OrderStatus[] = [
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
  status: OrderStatus;
  polls: number;
  transactions: OrderTransaction[];
}

export interface MockSolverOptions {
  readonly scenario?: 'happy' | 'refund';
  readonly bchTipHeight?: number;
}

function transaction(
  label: string,
  chain: 'base' | 'bch',
  hash: string,
): OrderTransaction {
  return { label, chain, hash };
}

function bchLockUtxo(): BchLockUtxo {
  return {
    txid: '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
    vout: 0,
    satoshis: BCH_CARRY_SATS,
  };
}

export class MockSolverClient implements SolverClient {
  readonly #orders = new Map<string, MockOrder>();
  readonly #scenario: 'happy' | 'refund';
  readonly #bchTipHeight: number;

  constructor(options: MockSolverOptions = {}) {
    this.#scenario = options.scenario ?? 'happy';
    this.#bchTipHeight = options.bchTipHeight ?? 329_315;
  }

  async quote(input: QuoteRequest): Promise<SignedQuote> {
    const request = QuoteRequestSchema.parse(input);
    if (request.direction !== 'COUNTER_TO_BCH') {
      throw new Error('Only the forward direction is enabled');
    }
    if (request.bchToken !== 'PUSD') {
      throw new Error('Only tPUSD is enabled');
    }
    if (request.counterChain !== 'base' || request.counterSymbol !== 'USDC') {
      throw new Error('Only Base USDC is enabled');
    }
    if (
      !checkLimits(request.amountIn, USDC_DECIMALS, {
        minUsdMicros: MIN_SWAP_USD_MICROS,
        maxUsdMicros: MAX_SWAP_USD_MICROS,
      })
    ) {
      throw new Error('Amount is outside the swap limits');
    }
    if (request.lane === 'fast' && request.fastOptIn !== true) {
      throw new Error('Fast lane requires explicit opt-in');
    }
    if (request.lane === 'fast' && request.amountIn > 25_000_000n) {
      throw new Error('Fast lane is limited to $25');
    }

    const bchTokenAmount = quoteExactIn(request.amountIn, USDC_DECIMALS, 2, {
      spreadBps: SPREAD_BPS,
      fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
    });
    if (bchTokenAmount <= 0n) throw new Error('Amount is too small after fees');

    const now = Math.floor(Date.now() / 1000);
    const terms: OrderTerms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: PUSD_CATEGORY,
      bchTokenAmount,
      counterAmount: request.amountIn,
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
      counterDeadline: now + FWD_EVM_DEADLINE_S,
      bchRefundHeight: this.#bchTipHeight + FWD_BCH_REFUND_BLOCKS,
      bchCarrySats: BCH_CARRY_SATS,
      bchMaxFee: BCH_MAX_FEE_SATS,
      quoteId: `mock-quote-${now}`,
      quoteExpiry: now + QUOTE_TTL_S,
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
      status: 'QUOTED',
      polls: 0,
      transactions: [],
    });
    return quote;
  }

  async relayLock(request: RelayLockRequest): Promise<{ txHash: string }> {
    const order = this.#orders.get(request.orderId);
    if (!order) throw new Error('Unknown order');
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

  async submitSecret(id: Hex32): Promise<void> {
    const order = this.#orders.get(id);
    if (!order) throw new Error('Unknown order');
    if (order.scenario !== 'happy') throw new Error('Order cannot reveal');
    if (order.status !== 'SOLVER_LOCK_SEEN') {
      throw new Error('The solver lock is not ready');
    }
    order.status = 'SECRET_KNOWN';
    order.polls = HAPPY_PATH.indexOf('SECRET_KNOWN') + 1;
  }

  #advance(order: MockOrder): void {
    order.polls += 1;
    const path = order.scenario === 'refund' ? REFUND_PATH : HAPPY_PATH;
    const index = Math.min(order.polls - 1, path.length - 1);
    const next = path[index];
    if (next) order.status = next;

    if (next === 'USER_LOCK_SEEN' && order.transactions.length === 0) {
      order.transactions.push(
        transaction('Base lock', 'base', `0x${'11'.repeat(32)}`),
      );
    }
    if (next === 'SOLVER_LOCK_BROADCAST') {
      order.transactions.push(
        transaction(
          'BCH lock',
          'bch',
          '7d5c1aef6d1a9e4a4f6cbf4b8e37e19c1d1c4d95c9d4c3b2a1908f7e6d5c4b3a',
        ),
      );
    }
    if (next === 'USER_CLAIM_SEEN') {
      order.transactions.push(
        transaction(
          'BCH claim',
          'bch',
          '9c2a1f5b4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c0a2f4e6d8c',
        ),
      );
    }
    if (next === 'SOLVER_CLAIM_BROADCAST') {
      order.transactions.push(
        transaction('Base claim', 'base', `0x${'22'.repeat(32)}`),
      );
    }
  }

  #view(id: Hex32, order: MockOrder): OrderView {
    const hasSolverLock =
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
      bchTipHeight: this.#bchTipHeight,
      updatedAt: Math.floor(Date.now() / 1000),
      transactions: order.transactions,
      bchLockUtxo: hasSolverLock ? bchLockUtxo() : null,
      claimAvailable: order.status === 'SOLVER_LOCK_SEEN',
      refundAvailable: order.status === 'REJECTED',
    };
  }

  #refundFixture(id: Hex32): MockOrder {
    const now = Math.floor(Date.now() / 1000);
    const terms = parseOrderTerms({
      version: 1,
      direction: 'COUNTER_TO_BCH',
      bchToken: 'PUSD',
      bchTokenCategory: PUSD_CATEGORY,
      bchTokenAmount: 991n,
      counterAmount: 10_000_000n,
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
      counterDeadline: now + FWD_EVM_DEADLINE_S,
      bchRefundHeight: this.#bchTipHeight + FWD_BCH_REFUND_BLOCKS,
      bchCarrySats: BCH_CARRY_SATS,
      bchMaxFee: BCH_MAX_FEE_SATS,
      quoteId: 'mock-refund',
      quoteExpiry: now + QUOTE_TTL_S,
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
      status: 'REJECTED',
      polls: REFUND_PATH.length,
      transactions: [transaction('Base lock', 'base', `0x${'11'.repeat(32)}`)],
    };
  }
}

export function createMockSolverClient(
  options: MockSolverOptions = {},
): SolverClient {
  return new MockSolverClient(options);
}

export const MOCK_SOLVER_ADDRESS: Address = solverAccount.address;
