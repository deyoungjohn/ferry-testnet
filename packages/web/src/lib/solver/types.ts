import type {
  CancelPayLinkRequest,
  CreatePayLinkRequest,
  HealthResponse,
  Hex32,
  Lane,
  ListPayLinksQuery,
  OrderStatus,
  OrderTerms,
  PayLink,
  PayLinkQuoteRequest,
  QuoteRequest,
  QuoteResponse,
} from '@ferry/core';
import type { Address, Hex } from 'viem';

export type { Lane, OrderStatus, QuoteRequest };

export type SignedQuote = QuoteResponse & { readonly bchTipHeight: number };

export interface RelayLockRequest {
  readonly orderId: Hex32;
  readonly terms: OrderTerms;
  readonly userEvmAddress: Address;
  readonly permitSignature: Hex;
  readonly intentSignature: Hex;
  readonly permitDeadline: number;
}

export interface BchLockUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
}

export interface OrderTransaction {
  readonly label: string;
  readonly chain: 'base' | 'bch';
  readonly hash: string;
}

export interface OrderView {
  readonly orderId: Hex32;
  readonly status: OrderStatus;
  readonly terms: OrderTerms;
  readonly lane: Lane;
  readonly bchTipHeight: number;
  readonly bchTipError: string | null;
  readonly updatedAt: number;
  readonly transactions: readonly OrderTransaction[];
  readonly bchLockUtxo: BchLockUtxo | null;
  readonly claimAvailable: boolean;
  readonly refundAvailable: boolean;
  readonly bchRefundAvailable: boolean;
}

export interface SolverClient {
  getHealth(): Promise<HealthResponse>;
  quote(request: QuoteRequest): Promise<SignedQuote>;
  createPayLink(request: CreatePayLinkRequest): Promise<PayLink>;
  getPayLink(id: string): Promise<PayLink>;
  quotePayLink(id: string, request: PayLinkQuoteRequest): Promise<SignedQuote>;
  listPayLinks(query: ListPayLinksQuery): Promise<readonly PayLink[]>;
  cancelPayLink(id: string, request: CancelPayLinkRequest): Promise<PayLink>;
  relayLock(request: RelayLockRequest): Promise<{ readonly txHash: string }>;
  getOrder(orderId: Hex32): Promise<OrderView>;
  submitSecret(orderId: Hex32, secret: Hex32): Promise<void>;
  relayClaim(orderId: Hex32, secret: Hex32): Promise<void>;
}

export { TERMINAL_ORDER_STATUSES as TERMINAL_STATUSES } from '@ferry/core';

export const STATUS_LABELS: Record<OrderStatus, string> = {
  QUOTED: 'Quote signed',
  USER_LOCK_SEEN: 'Your USDC lock seen',
  USER_LOCK_FINAL: 'Your USDC lock final',
  SOLVER_LOCK_BROADCAST: 'Solver BCH lock broadcast',
  SOLVER_LOCK_SEEN: 'Solver BCH lock seen',
  SECRET_KNOWN: 'Secret revealed',
  USER_CLAIM_SEEN: 'Your BCH claim seen',
  SOLVER_CLAIM_BROADCAST: 'Solver USDC claim broadcast',
  SOLVER_CLAIM_FINAL: 'Solver USDC claim final',
  DONE: 'Done',
  EXPIRED: 'Quote expired',
  REJECTED: 'Swap rejected',
  SOLVER_REFUND_BROADCAST: 'Solver refund broadcast',
  SOLVER_REFUNDED: 'Refunded',
};

export const REVERSE_STATUS_LABELS: Record<OrderStatus, string> = {
  QUOTED: 'Quote signed',
  USER_LOCK_SEEN: 'Your BCH lock seen',
  USER_LOCK_FINAL: 'Your BCH lock final',
  SOLVER_LOCK_BROADCAST: 'Solver USDC lock broadcast',
  SOLVER_LOCK_SEEN: 'Solver USDC lock seen',
  SECRET_KNOWN: 'Secret revealed',
  USER_CLAIM_SEEN: 'Your USDC claim seen',
  SOLVER_CLAIM_BROADCAST: 'Solver BCH claim broadcast',
  SOLVER_CLAIM_FINAL: 'Solver BCH claim final',
  DONE: 'Done',
  EXPIRED: 'Quote expired',
  REJECTED: 'Swap rejected',
  SOLVER_REFUND_BROADCAST: 'Solver refund broadcast',
  SOLVER_REFUNDED: 'Refunded',
};
