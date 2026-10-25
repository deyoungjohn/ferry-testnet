import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpStatsClient } from '../lib/stats/http';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpStatsClient', () => {
  it('validates all three local endpoint shapes and restores bigint fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/stats') {
          return new Response(
            JSON.stringify({
              completedSwaps: 2,
              volumeUsdMicros: '12000000',
              medianFastSeconds: 48,
              quotePolicy: {
                spreadBps: 40,
                fixedFeeUsdMicros: '50000',
              },
              asOf: 1_793_000_000,
            }),
          );
        }
        if (path === '/v1/orders/recent') {
          return new Response(
            JSON.stringify({
              swaps: [
                {
                  orderId: `0x${'11'.repeat(32)}`,
                  settledAt: 1_793_000_000,
                  direction: 'COUNTER_TO_BCH',
                  counterSymbol: 'USDC',
                  counterDecimals: 6,
                  counterAmount: '10000000',
                  bchSymbol: 'PUSD',
                  bchDecimals: 2,
                  bchTokenAmount: '991',
                  durationSeconds: 48,
                  baseTxId: `0x${'22'.repeat(32)}`,
                  bchTxId: '33'.repeat(32),
                },
              ],
            }),
          );
        }
        return new Response(
          JSON.stringify({
            pegs: [
              {
                token: 'PUSD',
                priceUsdMicros: '1001000',
                points: [
                  { at: 1_792_913_600, priceUsdMicros: '999000' },
                  { at: 1_793_000_000, priceUsdMicros: '1001000' },
                ],
                source: 'Paryon + Cauldron',
                asOf: 1_793_000_000,
              },
            ],
          }),
        );
      }),
    );

    const client = new HttpStatsClient('http://solver.test/');
    const [stats, swaps, pegs] = await Promise.all([
      client.getStats(),
      client.getRecentSwaps(),
      client.getPegs(),
    ]);

    expect(stats.volumeUsdMicros).toBe(12_000_000n);
    expect(stats.quotePolicy?.fixedFeeUsdMicros).toBe(50_000n);
    expect(swaps[0]?.counterAmount).toBe(10_000_000n);
    expect(pegs[0]?.points[0]?.priceUsdMicros).toBe(999_000n);
  });
});
