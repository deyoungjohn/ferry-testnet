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

export function SolverProvider({ children }: { readonly children: ReactNode }) {
  const client = useMemo(() => {
    const url = import.meta.env.VITE_SOLVER_URL;
    return url
      ? createHttpSolverClient(url)
      : createMockSolverClient({
          scenario: scenarioFromLocation(),
          direction: directionFromLocation(),
        });
  }, []);
  return (
    <SolverContext.Provider value={client}>{children}</SolverContext.Provider>
  );
}
