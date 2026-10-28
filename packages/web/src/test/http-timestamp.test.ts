import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../lib/solver/wait';
import { toSeconds } from '../lib/solver/http';

describe('solver timestamps', () => {
  it('converts milliseconds to seconds and leaves seconds alone', () => {
    expect(toSeconds(1_793_000_000_000)).toBe(1_793_000_000);
    expect(toSeconds(1_793_000_000)).toBe(1_793_000_000);
  });

  it('gives a non-zero elapsed time for a solver millisecond timestamp', () => {
    const nowSeconds = 1_793_000_125;
    const updatedAt = toSeconds(1_793_000_000_000);
    expect(formatElapsed(nowSeconds - updatedAt)).toBe('2m 5s');
  });
});

describe('older solver payloads', () => {
  it('accepts a real millisecond `updatedAt` from a solver started before an earlier change', async () => {
    const { OrderStatusResponseSchema } = await import('@ferry/core');
    const { normalizeTimestamps } = await import('../lib/solver/http');
    const fixture = (await import('./fixtures/solver-order-done-ms.json'))
      .default;
    expect(OrderStatusResponseSchema.safeParse(fixture).success).toBe(false);
    const parsed = OrderStatusResponseSchema.safeParse(
      normalizeTimestamps(fixture),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.updatedAt).toBe(1_793_191_256);
  });

  it('normalizes timestamps inside list items and leaves other numbers alone', async () => {
    const { normalizeTimestamps } = await import('../lib/solver/http');
    expect(
      normalizeTimestamps({
        swaps: [{ settledAt: 1_793_000_000_000, counterAmount: 10_000_000 }],
      }),
    ).toEqual({
      swaps: [{ settledAt: 1_793_000_000, counterAmount: 10_000_000 }],
    });
  });
});
