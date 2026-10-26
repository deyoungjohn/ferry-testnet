import { useEffect, useState } from 'react';
import type { HealthResponse } from '@ferry/core';
import { useSolver } from './context';

export type SolverHealthState =
  | { readonly status: 'loading'; readonly health: null }
  | { readonly status: 'ready'; readonly health: HealthResponse }
  | { readonly status: 'error'; readonly health: null };

export function useSolverHealth(pollMs = 30_000): SolverHealthState {
  const solver = useSolver();
  const [state, setState] = useState<SolverHealthState>({
    status: 'loading',
    health: null,
  });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const health = await solver.getHealth();
        if (active) setState({ status: 'ready', health });
      } catch {
        if (active) setState({ status: 'error', health: null });
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [pollMs, solver]);

  return state;
}
