import { useMemo, type ReactNode } from 'react';
import { createHttpSolverClient } from './http';
import type { OrderStatus } from '@ferry/core';
import { createMockSolverClient } from './mock';
import { SolverContext } from './context';

function scenarioFromLocation(): 'happy' | 'refund' {
  if (typeof window === 'undefined') return 'happy';
  return new URLSearchParams(window.location.search).get('scenario') ===
    'refund'
    ? 'refund'
    : 'happy';
}

function directionFromLocation(): 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER' {
  if (typeof window === 'undefined') return 'COUNTER_TO_BCH';
  return new URLSearchParams(window.location.search).get('direction') ===
    'reverse'
    ? 'BCH_TO_COUNTER'
    : 'COUNTER_TO_BCH';
}

function quoteFailureFromLocation():
  | 'rejected'
  | 'unavailable'
  | 'bch-tip'
  | 'evm-tip'
  | 'quoting-disabled'
  | 'unknown'
  | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('quoteFailure');
  return value === 'rejected' ||
    value === 'unavailable' ||
    value === 'bch-tip' ||
    value === 'evm-tip' ||
    value === 'quoting-disabled' ||
    value === 'unknown'
    ? value
    : undefined;
}

function holdStatusFromLocation(): OrderStatus | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('holdStatus');
  const statuses: readonly OrderStatus[] = [
    'QUOTED',
    'USER_LOCK_SEEN',
    'USER_LOCK_FINAL',
    'SOLVER_LOCK_BROADCAST',
    'SOLVER_LOCK_SEEN',
    'SECRET_KNOWN',
    'USER_CLAIM_SEEN',
    'SOLVER_CLAIM_BROADCAST',
    'SOLVER_CLAIM_FINAL',
    'DONE',
    'EXPIRED',
    'REJECTED',
    'SOLVER_REFUND_BROADCAST',
    'SOLVER_REFUNDED',
  ];
  return statuses.find((status) => status === value);
}

function holdAfterUserClaimFromLocation(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    new URLSearchParams(window.location.search).get('holdAfterClaim') === '1'
  );
}

function holdClaimFromLocation(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('holdClaim') === '1';
}

function quoteTtlFromLocation(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = Number(
    new URLSearchParams(window.location.search).get('quoteTtl'),
  );
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function SolverProvider({ children }: { readonly children: ReactNode }) {
  const client = useMemo(() => {
    const url = import.meta.env.VITE_SOLVER_URL;
    return url
      ? createHttpSolverClient(url)
      : createMockSolverClient({
          scenario: scenarioFromLocation(),
          direction: directionFromLocation(),
          ...(quoteTtlFromLocation() !== undefined
            ? { quoteTtlSeconds: quoteTtlFromLocation() }
            : {}),
          ...(quoteFailureFromLocation() !== undefined
            ? { quoteFailure: quoteFailureFromLocation() }
            : {}),
          ...(holdClaimFromLocation() ? { holdClaimStatus: true } : {}),
          ...(holdAfterUserClaimFromLocation()
            ? { holdAfterUserClaim: true }
            : {}),
          ...(holdStatusFromLocation()
            ? { holdStatus: holdStatusFromLocation() }
            : {}),
        });
  }, []);
  return (
    <SolverContext.Provider value={client}>{children}</SolverContext.Provider>
  );
}
