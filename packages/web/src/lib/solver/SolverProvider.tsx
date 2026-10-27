import { useMemo, type ReactNode } from 'react';
import { createHttpSolverClient } from './http';
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
        });
  }, []);
  return (
    <SolverContext.Provider value={client}>{children}</SolverContext.Provider>
  );
}
