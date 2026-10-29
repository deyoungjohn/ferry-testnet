import { describe, expect, it } from 'vitest';
import { SolverError, describeSolverError } from '../lib/solver/errors';
import { describeUsdcShortfall } from '../lib/swap';

describe('describeUsdcShortfall', () => {
  it('says what is missing in USDC units before any signature', () => {
    expect(describeUsdcShortfall(30_000_000n, 50_000_000n)).toBe(
      'You need 50 USDC but this wallet holds 30 USDC on Base. Lower the amount or add USDC.',
    );
  });

  it('allows a swap the wallet can cover', () => {
    expect(describeUsdcShortfall(50_000_000n, 50_000_000n)).toBeNull();
  });
});

describe('relay lock rejection copy', () => {
  it('explains an insufficient balance instead of an unexpected error', () => {
    const failure = describeSolverError(
      new SolverError('INSUFFICIENT_USER_BALANCE', 'x', 400),
      'Locking failed',
    );
    expect(failure.sentence).toContain('does not hold enough USDC');
  });
});
