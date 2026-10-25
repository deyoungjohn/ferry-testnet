import type { z } from 'zod';
import {
  PegsResponseSchema,
  RecentSwapsResponseSchema,
  StatsSummarySchema,
  type PegSnapshot,
  type RecentSwap,
  type StatsClient,
  type StatsSummary,
} from './types';

export class HttpStatsClient implements StatsClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
  }

  async #get<T>(schema: z.ZodType<T>, path: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { accept: 'application/json' },
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Stats request failed (${response.status.toString()})`);
    }
    return schema.parse(body);
  }

  getStats(): Promise<StatsSummary> {
    return this.#get(StatsSummarySchema, '/v1/stats');
  }

  async getRecentSwaps(): Promise<readonly RecentSwap[]> {
    return (await this.#get(RecentSwapsResponseSchema, '/v1/orders/recent'))
      .swaps;
  }

  async getPegs(): Promise<readonly PegSnapshot[]> {
    return (await this.#get(PegsResponseSchema, '/v1/pegs')).pegs;
  }
}

export function createHttpStatsClient(baseUrl: string): StatsClient {
  return new HttpStatsClient(baseUrl);
}
