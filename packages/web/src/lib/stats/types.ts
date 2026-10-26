export {
  PegPointSchema,
  PegSnapshotSchema,
  PegsResponseSchema,
  QuotePolicySchema,
  RecentSwapSchema,
  RecentSwapsResponseSchema,
  StatsSummarySchema,
  type PegPoint,
  type PegSnapshot,
  type PegToken,
  type QuotePolicy,
  type RecentSwap,
  type StatsSummary,
} from '@ferry/core';

import type { PegSnapshot, RecentSwap, StatsSummary } from '@ferry/core';

export interface StatsClient {
  getStats(): Promise<StatsSummary>;
  getRecentSwaps(): Promise<readonly RecentSwap[]>;
  getPegs(): Promise<readonly PegSnapshot[]>;
}

export type DataResource<T> =
  | { readonly status: 'loading'; readonly data: null }
  | { readonly status: 'ready'; readonly data: T }
  | { readonly status: 'error'; readonly data: null };
