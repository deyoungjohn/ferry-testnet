import type { ApiErrorCode } from '@ferry/core';

export type SolverFailureCode = ApiErrorCode | 'UNREACHABLE' | 'UNKNOWN';

export interface SolverErrorCopy {
  readonly sentence: string;
  readonly nextStep: string;
}

const COPY: Readonly<Record<SolverFailureCode, SolverErrorCopy>> = {
  BAD_REQUEST: {
    sentence: 'The solver rejected the request.',
    nextStep: 'Get a fresh quote and try again.',
  },
  VALIDATION_ERROR: {
    sentence: 'Some request details were not valid.',
    nextStep: 'Get a fresh quote and try again.',
  },
  INVALID_SIGNATURE: {
    sentence: 'The solver could not verify a signature.',
    nextStep: 'Reconnect the wallet and get a fresh quote.',
  },
  TERMS_MISMATCH: {
    sentence: 'The signed terms do not match what this page requested.',
    nextStep: 'Get a fresh quote and retry.',
  },
  AMOUNT_OUT_OF_RANGE: {
    sentence: 'That amount is outside this swap’s allowed range.',
    nextStep: 'Enter an amount between $1 and $50, then get a new quote.',
  },
  UNSUPPORTED_ROUTE: {
    sentence: 'This route is not available on the current solver.',
    nextStep: 'Use Base USDC ↔ BCH tPUSD or contact the operator.',
  },
  UNAUTHORIZED: {
    sentence: 'The solver could not authorize this action.',
    nextStep: 'Reconnect the relevant wallet and try again.',
  },
  NOT_FOUND: {
    sentence: 'The solver has no record of that item.',
    nextStep: 'Reload the page or check the link.',
  },
  ORDER_NOT_FOUND: {
    sentence: 'The solver has no record of this order.',
    nextStep: 'Use the local recovery record or open the recovery page.',
  },
  LINK_NOT_FOUND: {
    sentence: 'The solver has no record of this pay link.',
    nextStep: 'Check the link or ask the recipient for a new one.',
  },
  CONFLICT: {
    sentence: 'Another request changed this item first.',
    nextStep: 'Reload and try again.',
  },
  LINK_RESERVED: {
    sentence: 'This invoice is already being paid by another payer.',
    nextStep: 'Ask the recipient for a new link.',
  },
  LINK_CLOSED: {
    sentence: 'This pay link is closed.',
    nextStep: 'Ask the recipient for a new link.',
  },
  INVALID_ORDER_STATE: {
    sentence: 'This order is not in a state where that action is allowed.',
    nextStep: 'Reload the status page and use Claim or Refund when shown.',
  },
  QUOTE_EXPIRED: {
    sentence: 'The quote expired before the solver could use it.',
    nextStep: 'Get a fresh quote and download its new recovery file.',
  },
  LINK_EXPIRED: {
    sentence: 'This pay link has expired.',
    nextStep: 'Ask the recipient for a new link.',
  },
  REVEAL_NOT_READY: {
    sentence: 'The counter-lock is not ready to claim yet.',
    nextStep: 'Wait for Claim to appear on the status page, then retry.',
  },
  TIMING_INVARIANT_FAILED: {
    sentence:
      'The solver refused the quote because its timing safety window failed.',
    nextStep: 'Get a fresh quote; contact the operator if it repeats.',
  },
  RATE_LIMITED: {
    sentence: 'The solver is receiving too many requests.',
    nextStep: 'Wait a minute and retry.',
  },
  QUOTING_DISABLED: {
    sentence: 'Quoting is paused on the solver.',
    nextStep: 'Retry in a minute or check the solver health line.',
  },
  PEG_DEVIATION: {
    sentence: 'The stablecoin peg is outside the solver’s safety band.',
    nextStep: 'Wait for the peg to recover before quoting again.',
  },
  STALE_CHAIN_TIP: {
    sentence: 'A settlement chain’s tip is stale.',
    nextStep: 'Retry in a minute and check the solver health line.',
  },
  BCH_TIP_UNHEALTHY: {
    sentence: 'The solver cannot get a healthy Bitcoin Cash tip right now.',
    nextStep: 'Retry in a minute and check the solver health line.',
  },
  EVM_TIP_UNHEALTHY: {
    sentence: 'The solver cannot get a healthy Base tip right now.',
    nextStep: 'Retry in a minute and check the solver health line.',
  },
  INSUFFICIENT_USER_BALANCE: {
    sentence: 'Your wallet does not hold enough USDC for this swap.',
    nextStep: 'Lower the amount or add USDC on Base, then get a new quote.',
  },
  RELAY_LOCK_REVERTED: {
    sentence: 'The lock transaction was rejected by the chain.',
    nextStep: 'Get a new quote and retry; the code explains the reason.',
  },
  INSUFFICIENT_INVENTORY: {
    sentence: 'The solver does not have enough inventory for this swap.',
    nextStep: 'Try a smaller amount or retry later.',
  },
  EXPOSURE_LIMIT_EXCEEDED: {
    sentence: 'The solver’s open exposure limit has been reached.',
    nextStep: 'Try a smaller amount or retry later.',
  },
  UPSTREAM_ERROR: {
    sentence: 'A chain or RPC provider returned an error to the solver.',
    nextStep: 'Retry in a minute; contact the operator if it persists.',
  },
  INTERNAL_ERROR: {
    sentence: 'The solver hit an internal error.',
    nextStep: 'Retry once; contact the operator if it persists.',
  },
  UNREACHABLE: {
    sentence: 'Cannot reach the solver.',
    nextStep:
      'Check that the solver is running and the solver URL is correct, then retry.',
  },
  UNKNOWN: {
    sentence: 'The solver returned an unexpected error.',
    nextStep: 'Retry; if it persists, contact the operator with the code.',
  },
};

export interface SolverFailure {
  readonly sentence: string;
  readonly nextStep: string;
  readonly code: string | null;
  readonly kind: 'solver' | 'unreachable' | 'unknown' | 'local';
}

export class SolverError extends Error {
  readonly code: SolverFailureCode;
  readonly displayCode: string;
  readonly status: number | null;

  constructor(
    code: SolverFailureCode,
    message: string,
    status: number | null = null,
    displayCode: string = code,
  ) {
    super(message);
    this.name = 'SolverError';
    this.code = code;
    this.displayCode = displayCode;
    this.status = status;
  }

  get copy(): SolverErrorCopy {
    return COPY[this.code];
  }
}

function isSolverError(cause: unknown): cause is SolverError {
  return (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    'displayCode' in cause &&
    'copy' in cause
  );
}

export function describeSolverError(
  cause: unknown,
  localFallback = 'Something went wrong.',
): SolverFailure {
  if (isSolverError(cause)) {
    return {
      sentence: cause.copy.sentence,
      nextStep: cause.copy.nextStep,
      code: cause.displayCode,
      kind:
        cause.code === 'UNREACHABLE'
          ? 'unreachable'
          : cause.code === 'UNKNOWN'
            ? 'unknown'
            : 'solver',
    };
  }

  return {
    sentence:
      cause !== null &&
      typeof cause === 'object' &&
      'message' in cause &&
      typeof cause.message === 'string' &&
      cause.message.length > 0
        ? cause.message
        : localFallback,
    nextStep: 'Retry once; contact the operator if it persists.',
    code: null,
    kind: 'local',
  };
}
