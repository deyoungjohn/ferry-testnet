// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SolverHealthLine } from '../components/SolverHealthLine';
import { SolverContext } from '../lib/solver/context';
import { createMockSolverClient } from '../lib/solver/mock';
import type { SolverClient } from '../lib/solver/types';

describe('solver health line', () => {
  it('shows tip heights, ages and quoting with words, not colour', async () => {
    render(
      <SolverContext.Provider value={createMockSolverClient()}>
        <SolverHealthLine />
      </SolverContext.Provider>,
    );

    const line = await screen.findByRole('status');
    expect(line).toHaveTextContent(/Mock solver \(simulated health\)/i);
    expect(line).toHaveTextContent(/Quoting on/i);
    expect(line).toHaveTextContent(/BCH tip healthy/i);
    expect(line).toHaveTextContent(/Base tip healthy/i);
    expect(line).toHaveTextContent(/old\)/i);
  });

  it('shows an unavailable state when health cannot be fetched', async () => {
    const base = createMockSolverClient();
    const failing: SolverClient = {
      ...base,
      getHealth: async () => {
        throw new Error('network down');
      },
    };
    render(
      <SolverContext.Provider value={failing}>
        <SolverHealthLine />
      </SolverContext.Provider>,
    );

    expect(
      await screen.findByText(/Solver health: unavailable/i),
    ).toBeInTheDocument();
  });
});
