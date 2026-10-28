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
