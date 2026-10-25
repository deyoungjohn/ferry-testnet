import { afterEach, describe, expect, it, vi } from 'vitest';
import { solverIsLive } from '../lib/solver/kind';

describe(' solver kind drives labels and explorer links', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is not live without VITE_SOLVER_URL (mock solver)', () => {
    vi.stubEnv('VITE_SOLVER_URL', '');
    expect(solverIsLive()).toBe(false);
  });

  it('is live when VITE_SOLVER_URL is set', () => {
    vi.stubEnv('VITE_SOLVER_URL', 'http://localhost:8787');
    expect(solverIsLive()).toBe(true);
  });
});
