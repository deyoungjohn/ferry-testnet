import { useMemo, type ReactNode } from 'react';
import { StatsContext } from './context';
import { createHttpStatsClient } from './http';
import { createMockStatsClient } from './mock';
import type { StatsClient } from './types';

export function StatsProvider({
  children,
  client,
}: {
  readonly children: ReactNode;
  readonly client?: StatsClient;
}) {
  const value = useMemo(() => {
    if (client) return client;
    const solverUrl = import.meta.env.VITE_SOLVER_URL;
    return solverUrl && import.meta.env.MODE !== 'test'
      ? createHttpStatsClient(solverUrl)
      : createMockStatsClient();
  }, [client]);

  return (
    <StatsContext.Provider value={value}>{children}</StatsContext.Provider>
  );
}
