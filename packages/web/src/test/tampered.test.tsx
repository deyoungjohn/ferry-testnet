// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { orderId } from '@ferry/core';
import { keccak256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SwapCard } from '../components/SwapCard';
import { SolverContext } from '../lib/solver/context';
import { createMockSolverClient } from '../lib/solver/mock';
import type { SolverClient } from '../lib/solver/types';
import { MockWalletProvider } from '../lib/wallet/mock';

describe('tampered quote', () => {
  it('does not enable the CTA when the signed terms changed', async () => {
    const base = createMockSolverClient();
    const tampered: SolverClient = {
      ...base,
      quote: async (request) => {
        const quote = await base.quote(request);
        return {
          ...quote,
          terms: {
            ...quote.terms,
            bchTokenAmount: quote.terms.bchTokenAmount + 1n,
          },
        };
      },
    };

    render(
      <MemoryRouter>
        <MockWalletProvider>
          <SolverContext.Provider value={tampered}>
            <SwapCard />
          </SolverContext.Provider>
        </MockWalletProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect BCH' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(
      /signature does not match/i,
    );
    expect(
      screen.queryByRole('button', { name: /ferry it/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /download recovery file/i }),
    ).not.toBeInTheDocument();
  });
});

describe('T9 request binding', () => {
  it('does not enable the CTA when a validly signed quote changes the solver recipient', async () => {
    const base = createMockSolverClient();
    const solverAccount = privateKeyToAccount(
      keccak256(toBytes('ferry.mock.solver.v1')),
    );
    const tampered: SolverClient = {
      ...base,
      quote: async (request) => {
        const quote = await base.quote(request);
        const terms = {
          ...quote.terms,
          solverCounterAddress:
            '0x0000000000000000000000000000000000000001' as const,
        };
        const id = orderId(terms);
        const signature = await solverAccount.signMessage({
          message: { raw: id },
        });
        return { ...quote, terms, orderId: id, signature };
      },
    };

    render(
      <MemoryRouter>
        <MockWalletProvider>
          <SolverContext.Provider value={tampered}>
            <SwapCard />
          </SolverContext.Provider>
        </MockWalletProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect BCH' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(
      /solver counter address does not match/i,
    );
    expect(
      screen.queryByRole('button', { name: /ferry it/i }),
    ).not.toBeInTheDocument();
  });
});
