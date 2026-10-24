import { describe, expect, it } from 'vitest';
import {
  erlangQuantile,
  invariantF,
  invariantR,
  DEFAULT_TIMING_CONFIG,
} from '../src/timing.js';
const start = { unixSeconds: 1800000000, bchTipHeight: 1000000 };
const config = DEFAULT_TIMING_CONFIG;
describe('Erlang block timing and deadline invariants', () => {
  it('matches exponential closed form and independent 65-digit Decimal Poisson-sum references', () => {
    expect(erlangQuantile(0, 0.5)).toBe(0);
    expect(erlangQuantile(1, 0.9999)).toBeCloseTo(-600 * Math.log(0.0001), 7);
    expect(erlangQuantile(1, 0.0001)).toBeCloseTo(0.060003000200015, 9);
    expect(erlangQuantile(36, 0.9999)).toBeCloseTo(37612.989039208216, 6);
    expect(erlangQuantile(108, 0.0001)).toBeCloseTo(44131.23873326337, 6);
    expect(erlangQuantile(144, 0.0001)).toBeCloseTo(62150.48193527783, 6);
    expect(erlangQuantile(36, 0.9999, 300)).toBeCloseTo(18806.494519604108, 6);
  });
  it('rejects invalid numerical inputs', () => {
    for (const n of [-1, 0.5, 10001, NaN])
      expect(() => erlangQuantile(n, 0.5)).toThrow();
    for (const p of [0, 1, -1, NaN])
      expect(() => erlangQuantile(1, p)).toThrow();
    expect(() => erlangQuantile(1, 0.5, 0)).toThrow();
  });
  it('F accepts equality and rejects the smallest practical deficit', () => {
    const needed =
      erlangQuantile(36, 0.9999) +
      config.solverReactionSeconds +
      config.safetySeconds;
    const terms = {
      bchRefundHeight: start.bchTipHeight + 36,
      counterDeadline: start.unixSeconds + 86400,
    };
    expect(invariantF(terms, start).allowed).toBe(true);
    const boundary = { ...start, unixSeconds: terms.counterDeadline - needed };
    expect(invariantF(terms, boundary).marginSeconds).toBeCloseTo(0, 5);
    expect(
      invariantF(terms, {
        ...boundary,
        unixSeconds: boundary.unixSeconds + 0.001,
      }).allowed,
    ).toBe(false);
    expect(
      invariantF({ ...terms, bchRefundHeight: start.bchTipHeight }, start)
        .allowed,
    ).toBe(false);
    expect(
      invariantF({ ...terms, counterDeadline: start.unixSeconds }, start)
        .allowed,
    ).toBe(false);
  });
  it('R enforces remaining blocks, quantile margin and expiration boundaries', () => {
    const terms = {
      bchRefundHeight: start.bchTipHeight + 108,
      counterDeadline: start.unixSeconds + 21600,
    };
    expect(invariantR(terms, start).allowed).toBe(true);
    expect(
      invariantR({ ...terms, bchRefundHeight: start.bchTipHeight + 107 }, start)
        .allowed,
    ).toBe(false);
    expect(
      invariantR({ ...terms, bchRefundHeight: start.bchTipHeight }, start)
        .allowed,
    ).toBe(false);
    const maxDuration =
      erlangQuantile(108, 0.0001) -
      config.solverReactionSeconds -
      config.safetySeconds;
    expect(
      invariantR(
        { ...terms, counterDeadline: start.unixSeconds + maxDuration - 0.001 },
        start,
      ).allowed,
    ).toBe(true);
    expect(
      invariantR(
        { ...terms, counterDeadline: start.unixSeconds + maxDuration + 0.001 },
        start,
      ).allowed,
    ).toBe(false);
    expect(
      invariantR({ ...terms, counterDeadline: start.unixSeconds }, start)
        .allowed,
    ).toBe(false);
    expect(() =>
      invariantR(terms, start, { ...config, safetySeconds: -1 }),
    ).toThrow();
    expect(() => invariantF(terms, { ...start, bchTipHeight: 0.5 })).toThrow();
    expect(() => invariantF(terms, { ...start, unixSeconds: NaN })).toThrow();
  });
  it('accepts exact mathematical equality at both invariant boundaries', () => {
    const start = { unixSeconds: 0, bchTipHeight: 0 };
    const config = {
      ...DEFAULT_TIMING_CONFIG,
      solverReactionSeconds: 0,
      safetySeconds: 0,
    };
    expect(
      invariantF(
        { bchRefundHeight: 36, counterDeadline: erlangQuantile(36, 0.9999) },
        start,
        config,
      ).allowed,
    ).toBe(true);
    expect(
      invariantR(
        { bchRefundHeight: 108, counterDeadline: erlangQuantile(108, 0.0001) },
        start,
        config,
      ).allowed,
    ).toBe(true);
  });
});
