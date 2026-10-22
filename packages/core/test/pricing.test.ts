import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  quoteExactIn,
  quoteExactOut,
  convertFloor,
  convertCeil,
  checkLimits,
  pegGuard,
  effectiveSpreadBps,
} from '../src/pricing.js';

const policy = { spreadBps: 40, fixedFeeUsdMicros: 50000n };
const runs = { numRuns: 1000, seed: 220026 };
describe('integer pricing', () => {
  it('quotes both directions with the same dollar fee and solver-favoring floor', () => {
    expect(quoteExactIn(25000000n, 6, 2, policy)).toBe(2485n);
    expect(quoteExactIn(2500n, 2, 6, policy)).toBe(24850000n);
    expect(quoteExactIn(25000000000000000000n, 18, 2, policy)).toBe(2485n);
    expect(quoteExactOut(2500n, 6, 2, policy)).toBe(25150603n);
    expect(quoteExactIn(0n, 6, 2, policy)).toBe(0n);
    expect(quoteExactIn(1n, 6, 2, policy)).toBe(0n);
    expect(quoteExactOut(0n, 6, 2, policy)).toBe(0n);
  });
  for (const [from, to] of [
    [6, 2],
    [2, 6],
    [18, 2],
    [2, 18],
  ] as const) {
    it(`${from}→${to} floor/ceil never favors user; monotonic; exact-output covers recipient (1000 runs)`, () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 0n, max: 10n ** 24n }),
          fc.bigInt({ min: 0n, max: 10n ** 20n }),
          fc.integer({ min: 0, max: 9999 }),
          (input, output, spreadBps) => {
            const unitFrom = 10n ** BigInt(from),
              unitTo = 10n ** BigInt(to);
            const floor = convertFloor(input, from, to),
              ceil = convertCeil(input, from, to);
            expect(floor * unitFrom <= input * unitTo).toBe(true);
            expect(ceil * unitFrom >= input * unitTo).toBe(true);
            const config = { ...policy, spreadBps };
            const a = quoteExactIn(input, from, to, config),
              b = quoteExactIn(input + 1n, from, to, config);
            expect(a >= 0n && b >= a).toBe(true);
            const exact = quoteExactOut(output, from, to, config);
            expect(quoteExactIn(exact, from, to, config) >= output).toBe(true);
            if (exact > 0n)
              expect(quoteExactIn(exact - 1n, from, to, config) < output).toBe(
                true,
              );
          },
        ),
        runs,
      );
    });
  }
  it('rejects invalid inputs, decimals, spread and negative fee', () => {
    for (const decimals of [-1, 1.5, 37, NaN])
      expect(() => convertFloor(1n, decimals, 2)).toThrow();
    expect(() => convertCeil(-1n, 6, 2)).toThrow();
    for (const spreadBps of [-1, 10000, 1.5, NaN])
      expect(() => quoteExactIn(1n, 6, 2, { ...policy, spreadBps })).toThrow();
    expect(() => quoteExactOut(-1n, 6, 2, policy)).toThrow();
    expect(() =>
      quoteExactIn(1n, 6, 2, { ...policy, fixedFeeUsdMicros: -1n }),
    ).toThrow();
  });
  it('uses inclusive limits without a preliminary lossy decimal conversion', () => {
    const limits = { minUsdMicros: 1000000n, maxUsdMicros: 50000000n };
    expect(checkLimits(10n ** 18n, 18, limits)).toBe(true);
    expect(checkLimits(10n ** 18n - 1n, 18, limits)).toBe(false);
    expect(checkLimits(50n * 10n ** 18n, 18, limits)).toBe(true);
    expect(checkLimits(50n * 10n ** 18n + 1n, 18, limits)).toBe(false);
    expect(() =>
      checkLimits(1n, 6, { minUsdMicros: 2n, maxUsdMicros: 1n }),
    ).toThrow();
  });
  it('guards supplied issuer/spot prices and source disagreement; missing data fails closed', () => {
    const check = (prices: bigint[], spreadTolerance = 10000n) =>
      pegGuard(prices, spreadTolerance);
    expect(check([1000000n, 1000000n])).toBe(true);
    expect(check([990000n, 1000000n])).toBe(true);
    expect(check([989999n])).toBe(false);
    expect(check([1010001n])).toBe(false);
    expect(check([990000n, 1010000n])).toBe(false);
    expect(check([])).toBe(false);
    expect(check([0n])).toBe(false);
    expect(() => check([1000000n], -1n)).toThrow();
    expect(() => check([1000000n], 1000001n)).toThrow();
  });
  it('caps signed inventory skew in both directions', () => {
    expect(effectiveSpreadBps(40, 100, 'COUNTER_TO_BCH', 50)).toBe(90);
    expect(effectiveSpreadBps(40, 100, 'BCH_TO_COUNTER', 50)).toBe(0);
    expect(effectiveSpreadBps(40, -100, 'COUNTER_TO_BCH', 50)).toBe(0);
    expect(effectiveSpreadBps(9990, 50, 'COUNTER_TO_BCH', 50)).toBe(9999);
    expect(() => effectiveSpreadBps(40, NaN, 'COUNTER_TO_BCH', 50)).toThrow();
    expect(() => effectiveSpreadBps(40, 1, 'COUNTER_TO_BCH', -1)).toThrow();
  });
});
