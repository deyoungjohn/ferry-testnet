import { describe, expect, it } from 'vitest';
import { MOCK_PRICING, quoteMockUsdToPusd } from '../lib/mock/swap';

describe('quoteMockUsdToPusd', () => {
  it('applies the 40 bps spread and fixed fee, floored to cents', () => {
    const quote = quoteMockUsdToPusd(42.5);

    expect(quote.inputUsd).toBe(42.5);
    expect(quote.outputUsd).toBe(42.28);
    expect(quote.rate).toBeCloseTo(0.9948, 4);
    expect(quote.spreadBps).toBe(40);
    expect(quote.fixedFeeUsd).toBe(0.05);
  });

  it('floors the post-spread amount instead of rounding it', () => {
    expect(quoteMockUsdToPusd(1).outputUsd).toBe(0.94);
    expect(quoteMockUsdToPusd(2.01).outputUsd).toBe(1.95);
  });

  it('quotes at the $50 cap', () => {
    expect(quoteMockUsdToPusd(MOCK_PRICING.maxSwapUsd).outputUsd).toBe(49.75);
  });

  it('rejects amounts above the cap', () => {
    expect(() => quoteMockUsdToPusd(50.01)).toThrow(RangeError);
  });

  it('rejects non-positive and non-finite amounts', () => {
    expect(() => quoteMockUsdToPusd(0)).toThrow(RangeError);
    expect(() => quoteMockUsdToPusd(-1)).toThrow(RangeError);
    expect(() => quoteMockUsdToPusd(Number.NaN)).toThrow(RangeError);
  });

  it('rejects amounts whose output is consumed by the fixed fee', () => {
    expect(() => quoteMockUsdToPusd(0.06)).toThrow(RangeError);
  });
});
