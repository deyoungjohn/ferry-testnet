import { createContext, useContext } from 'react';
import type { SolverClient } from './types';

export const SolverContext = createContext<SolverClient | null>(null);

export function useSolver(): SolverClient {
  const value = useContext(SolverContext);
  if (!value) throw new Error('useSolver must be used inside SolverProvider');
  return value;
}
