// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { SolverProvider } from '../lib/solver/SolverProvider';
import { StatsProvider } from '../lib/stats/StatsProvider';
import { MockWalletProvider } from '../lib/wallet/mock';
import { listVaultOrderIds } from '../lib/vault';

const SECRET = `0x${'ab'.repeat(32)}`;

vi.mock('../lib/swap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/swap')>();
  return { ...actual, generateSecret: () => SECRET };
});

describe('secret exposure', () => {
  it('never renders or keys the generated secret', async () => {
    render(
      <MemoryRouter>
        <MockWalletProvider>
          <SolverProvider>
            <StatsProvider>
              <App />
            </StatsProvider>
          </SolverProvider>
        </MockWalletProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect BCH' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect Base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));

    await screen.findByRole(
      'button',
      { name: /download recovery file/i },
      { timeout: 15_000 },
    );

    expect(document.body.textContent).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    const keys = await listVaultOrderIds();
    expect(keys.join(' ')).not.toContain(SECRET);
  }, 20_000);
});
