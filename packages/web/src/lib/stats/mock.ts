import { FIXED_FEE_USD_MICROS, SPREAD_BPS } from '../config';
import type {
  PegSnapshot,
  RecentSwap,
  StatsClient,
  StatsSummary,
} from './types';

const EMPTY_STATS: StatsSummary = {
  completedSwaps: null,
  volumeUsdMicros: null,
  medianFastSeconds: null,
  quotePolicy: {
    spreadBps: SPREAD_BPS,
    fixedFeeUsdMicros: FIXED_FEE_USD_MICROS,
  },
  asOf: null,
};

const EMPTY_PEGS: readonly PegSnapshot[] = [
  {
    token: 'PUSD',
    priceUsdMicros: null,
    points: [],
    source: null,
    asOf: null,
  },
  {
    token: 'MUSD',
    priceUsdMicros: null,
    points: [],
    source: null,
    asOf: null,
  },
];

export interface MockStatsOptions {
  readonly stats?: StatsSummary;
  readonly recentSwaps?: readonly RecentSwap[];
  readonly pegs?: readonly PegSnapshot[];
}

export class MockStatsClient implements StatsClient {
  readonly #stats: StatsSummary;
  readonly #recentSwaps: readonly RecentSwap[];
  readonly #pegs: readonly PegSnapshot[];

  constructor(options: MockStatsOptions = {}) {
    this.#stats = options.stats ?? EMPTY_STATS;
    this.#recentSwaps = options.recentSwaps ?? [];
    this.#pegs = options.pegs ?? EMPTY_PEGS;
  }

  async getStats(): Promise<StatsSummary> {
    return this.#stats;
  }

  async getRecentSwaps(): Promise<readonly RecentSwap[]> {
    return this.#recentSwaps;
  }

  async getPegs(): Promise<readonly PegSnapshot[]> {
    return this.#pegs;
  }
}

export function createMockStatsClient(options?: MockStatsOptions): StatsClient {
  return new MockStatsClient(options);
}
