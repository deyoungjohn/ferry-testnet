import type { OrderTerms } from '@ferry/core';

export type ForwardOrderStatus =
  | 'QUOTED'
  | 'USER_LOCK_SEEN'
  | 'USER_LOCK_FINAL'
  | 'SOLVER_LOCK_BROADCAST'
  | 'SOLVER_LOCK_SEEN'
  | 'SECRET_KNOWN'
  | 'USER_CLAIM_SEEN'
  | 'SOLVER_CLAIM_BROADCAST'
  | 'SOLVER_CLAIM_FINAL'
  | 'DONE'
  | 'EXPIRED'
  | 'REJECTED'
  | 'SOLVER_REFUNDED';

export type SecretSource = 'cooperative' | 'on_chain_claim';

export interface SolverOrderRecord {
  id: string; // sha256 orderId
  direction: 'BCH_TO_COUNTER' | 'COUNTER_TO_BCH';
  status: ForwardOrderStatus;
  terms: OrderTerms;
  hashLock: `0x${string}`;
  secret?: `0x${string}` | undefined;
  secretSource?: SecretSource | undefined;
  userLockTxId?: string | undefined;
  solverLockTxId?: string | undefined;
  userClaimTxId?: string | undefined;
  solverClaimTxId?: string | undefined;
  solverRefundTxId?: string | undefined;
  needsAttention?: boolean | undefined;
  rejectionReason?: string | undefined;
  createdAt: number;
  updatedAt: number;
}

export type SolverEvent =
  | { type: 'USER_LOCK_SEEN'; txId: string }
  | { type: 'USER_LOCK_FINAL'; txId: string }
  | { type: 'SOLVER_LOCK_BROADCAST'; txId: string }
  | { type: 'SOLVER_LOCK_SEEN'; txId: string }
  | { type: 'SECRET_REVEALED_COOPERATIVE'; secret: `0x${string}` }
  | { type: 'USER_CLAIM_SEEN'; txId: string; secret: `0x${string}` }
  | { type: 'SOLVER_CLAIM_BROADCAST'; txId: string }
  | { type: 'SOLVER_CLAIM_FINAL'; txId: string }
  | { type: 'SWAP_COMPLETE' }
  | { type: 'QUOTE_EXPIRED' }
  | { type: 'INVALID_TERMS'; reason: string }
  | { type: 'BCH_DEADLINE_PASSED'; refundTxId: string };

export interface TransitionResult {
  nextStatus: ForwardOrderStatus;
  mutations?: Partial<SolverOrderRecord>;
}
