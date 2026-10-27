import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  isFastLaneEligible,
  fastLaneMaxTokenAmount,
} from '../lib/solver/wait';

describe('wait-state formatting', () => {
  it('shows elapsed time instead of the quote-expired label', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(65)).toBe('1m 5s');
    expect(formatElapsed(3_700)).toBe('1h 1m');
  });

  it('uses the configured fast-lane cap', () => {
    expect(fastLaneMaxTokenAmount()).toBe(2_500n);
    expect(isFastLaneEligible(2_500n)).toBe(true);
    expect(isFastLaneEligible(2_501n)).toBe(false);
  });
});
