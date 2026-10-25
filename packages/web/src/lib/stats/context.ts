import { createContext, useContext } from 'react';
import type { StatsClient } from './types';

export const StatsContext = createContext<StatsClient | null>(null);

export function useStats(): StatsClient {
  const client = useContext(StatsContext);
  if (!client) throw new Error('StatsProvider is missing');
  return client;
}
