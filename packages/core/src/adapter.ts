import type { CounterChain, Hex32, OrderTerms } from './terms.js';
import type { Lane } from './reveal.js';
export interface CounterAsset {
  symbol: 'USDC' | 'USDT';
  decimals: number;
  address: string;
  permit: boolean;
}
/** Opaque EVM/Tron transaction hash or Solana base58 signature. */
export interface TxRef {
  chain: CounterChain;
  txId: string;
}
/** Adapter-owned payloads; core never interprets signatures or transactions. */
export interface UnsignedLock {
  chain: CounterChain;
  orderId: Hex32;
  payload: unknown;
}
export interface SignedLock {
  chain: CounterChain;
  orderId: Hex32;
  payload: unknown;
}
export interface LockData {
  owner: string;
  recipient: string;
  asset: CounterAsset;
  amount: bigint;
  hashLock: Hex32;
  deadline: number;
}
export type LockState =
  | { status: 'absent' }
  | ({ status: 'locked'; lockTx: TxRef } & LockData)
  | ({
      status: 'claimed';
      lockTx: TxRef;
      claimTx: TxRef;
      secret: Hex32 | null;
    } & LockData)
  | ({ status: 'refunded'; lockTx: TxRef; refundTx: TxRef } & LockData);
/** Deduplicate eventId; removed=true retracts a reorged observation.
 * Claimed.secret is on-chain evidence, never a log/analytics field. */
export type LockEvent = {
  eventId: string;
  lockId: string;
  tx: TxRef;
  removed: boolean;
} & (
  | { type: 'Locked'; lock: LockData }
  | { type: 'Claimed'; secret: Hex32 }
  | { type: 'Refunded' }
);
export type Unsubscribe = () => void;
/** Adapters validate every term and reject chain/asset mismatches. */
export interface ChainAdapter {
  readonly id: CounterChain;
  readonly assets: readonly CounterAsset[];
  /** Pure, deterministic and idempotent; never broadcasts or reserves. */
  lockId(owner: string, hashLock: Hex32): string;
  /** Repeatable preparation only; no broadcast. Signatures remain wallet-owned. */
  buildUserLock(terms: OrderTerms): Promise<UnsignedLock>;
  /** Retry identical signed requests idempotently; return their known tx when submitted.
   * Broadcast acceptance is provisional until isFinal. */
  relayLock(signed: SignedLock): Promise<TxRef>;
  /** Reuse order identity on retry; return a matching existing lock, never double-fund.
   * Reject conflicting locks. Returned submission is provisional until isFinal. */
  lock(terms: OrderTerms): Promise<TxRef>;
  /** Permissionless; retries reuse the existing matching claim or logical request.
   * Reject incompatible terminal state. Claim stays valid after deadline; races remain. */
  claim(lockId: string, secret: Hex32): Promise<TxRef>;
  /** Permissionless after deadline; retries reuse the matching refund.
   * Reject premature/already-claimed refunds. Returned tx is provisional until isFinal. */
  refund(lockId: string): Promise<TxRef>;
  /** Read-only; repeatable at a fixed view. Provisional states can change on reorg. */
  getLock(lockId: string): Promise<LockState>;
  /** At-least-once provisional events and removals; no implicit finality.
   * Each call owns a subscription; unsubscribe is itself idempotent. */
  watch(onEvent: (event: LockEvent) => void): Unsubscribe;
  /** Read-only lane policy in the canonical view; may become false on reorg.
   * Unavailable finality evidence must fail closed. */
  isFinal(tx: TxRef, lane: Lane): Promise<boolean>;
  /** Read-only, no reservation; repeat calls can reflect changed fees. */
  estimateRelayCostUsd(): Promise<number>;
  /** Read-only chain tip height and freshness. */
  getTip?(): Promise<{ height: number; timestamp: number; ageSeconds: number }>;
}
