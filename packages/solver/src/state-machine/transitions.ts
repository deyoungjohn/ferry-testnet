import type {
  SolverEvent,
  SolverOrderRecord,
  TransitionResult,
} from './types.js';

export function transition(
  order: SolverOrderRecord,
  event: SolverEvent,
): TransitionResult {
  const current = order.status;

  // Terminal states cannot transition
  if (
    current === 'DONE' ||
    current === 'EXPIRED' ||
    current === 'REJECTED' ||
    current === 'SOLVER_REFUNDED'
  ) {
    return { nextStatus: current };
  }

  switch (event.type) {
    case 'USER_LOCK_SEEN': {
      if (current === 'QUOTED') {
        return {
          nextStatus: 'USER_LOCK_SEEN',
          mutations: { userLockTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'USER_LOCK_FINAL': {
      if (current === 'QUOTED' || current === 'USER_LOCK_SEEN') {
        return {
          nextStatus: 'USER_LOCK_FINAL',
          mutations: { userLockTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'SOLVER_LOCK_BROADCAST': {
      if (current === 'USER_LOCK_FINAL') {
        return {
          nextStatus: 'SOLVER_LOCK_BROADCAST',
          mutations: { solverLockTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'SOLVER_LOCK_SEEN': {
      if (
        current === 'USER_LOCK_FINAL' ||
        current === 'SOLVER_LOCK_BROADCAST'
      ) {
        return {
          nextStatus: 'SOLVER_LOCK_SEEN',
          mutations: { solverLockTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'SECRET_REVEALED_COOPERATIVE': {
      if (current === 'SOLVER_LOCK_SEEN') {
        return {
          nextStatus: 'SECRET_KNOWN',
          mutations: {
            secret: event.secret,
            secretSource: 'cooperative',
          },
        };
      }
      if (
        current === 'SECRET_KNOWN' ||
        current === 'USER_CLAIM_SEEN' ||
        current === 'SOLVER_CLAIM_BROADCAST' ||
        current === 'SOLVER_CLAIM_FINAL'
      ) {
        return { nextStatus: current };
      }
      throw new Error(
        `Cannot accept cooperative secret reveal in state ${current}`,
      );
    }

    case 'USER_CLAIM_SEEN': {
      if (
        current === 'QUOTED' ||
        current === 'USER_LOCK_SEEN' ||
        current === 'USER_LOCK_FINAL' ||
        current === 'SOLVER_LOCK_BROADCAST' ||
        current === 'SOLVER_LOCK_SEEN' ||
        current === 'SECRET_KNOWN'
      ) {
        return {
          nextStatus: 'USER_CLAIM_SEEN',
          mutations: {
            userClaimTxId: event.txId,
            secret: event.secret,
            secretSource: 'on_chain_claim',
          },
        };
      }
      if (
        current === 'USER_CLAIM_SEEN' ||
        current === 'SOLVER_CLAIM_BROADCAST' ||
        current === 'SOLVER_CLAIM_FINAL'
      ) {
        return { nextStatus: current };
      }
      throw new Error(`Unexpected USER_CLAIM_SEEN in state ${current}`);
    }

    case 'SOLVER_CLAIM_BROADCAST': {
      if (current === 'USER_CLAIM_SEEN') {
        return {
          nextStatus: 'SOLVER_CLAIM_BROADCAST',
          mutations: { solverClaimTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'SOLVER_CLAIM_FINAL': {
      if (
        current === 'QUOTED' ||
        current === 'USER_LOCK_SEEN' ||
        current === 'USER_LOCK_FINAL' ||
        current === 'SOLVER_LOCK_BROADCAST' ||
        current === 'SOLVER_LOCK_SEEN' ||
        current === 'SECRET_KNOWN' ||
        current === 'USER_CLAIM_SEEN' ||
        current === 'SOLVER_CLAIM_BROADCAST'
      ) {
        return {
          nextStatus: 'SOLVER_CLAIM_FINAL',
          mutations: { solverClaimTxId: event.txId },
        };
      }
      return { nextStatus: current };
    }

    case 'SWAP_COMPLETE': {
      return { nextStatus: 'DONE' };
    }

    case 'QUOTE_EXPIRED': {
      if (current === 'QUOTED') {
        return { nextStatus: 'EXPIRED' };
      }
      return { nextStatus: current };
    }

    case 'INVALID_TERMS': {
      if (
        current === 'QUOTED' ||
        current === 'USER_LOCK_SEEN' ||
        current === 'USER_LOCK_FINAL'
      ) {
        return {
          nextStatus: 'REJECTED',
          mutations: { rejectionReason: event.reason },
        };
      }
      return { nextStatus: current };
    }

    case 'BCH_DEADLINE_PASSED': {
      if (
        current === 'SOLVER_LOCK_SEEN' ||
        current === 'SECRET_KNOWN' ||
        current === 'SOLVER_LOCK_BROADCAST'
      ) {
        return {
          nextStatus: 'SOLVER_REFUNDED',
          mutations: { solverRefundTxId: event.refundTxId },
        };
      }
      return { nextStatus: current };
    }

    default: {
      const _exhaustive: never = event;
      throw new Error(`Unhandled event type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
