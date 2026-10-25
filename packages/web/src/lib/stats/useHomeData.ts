import { useEffect, useState } from 'react';
import { useStats } from './context';
import type {
  DataResource,
  PegSnapshot,
  RecentSwap,
  StatsSummary,
} from './types';

export interface HomeData {
  readonly stats: DataResource<StatsSummary>;
  readonly recentSwaps: DataResource<readonly RecentSwap[]>;
  readonly pegs: DataResource<readonly PegSnapshot[]>;
}

const loading = { status: 'loading', data: null } as const;

function settledResource<T>(result: PromiseSettledResult<T>): DataResource<T> {
  return result.status === 'fulfilled'
    ? { status: 'ready', data: result.value }
    : { status: 'error', data: null };
}

export function useHomeData(): HomeData {
  const client = useStats();
  const [data, setData] = useState<HomeData>({
    stats: loading,
    recentSwaps: loading,
    pegs: loading,
  });

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      client.getStats(),
      client.getRecentSwaps(),
      client.getPegs(),
    ]).then(([stats, recentSwaps, pegs]) => {
      if (!active) return;
      setData({
        stats: settledResource(stats),
        recentSwaps: settledResource(recentSwaps),
        pegs: settledResource(pegs),
      });
    });
    return () => {
      active = false;
    };
  }, [client]);

  return data;
}
