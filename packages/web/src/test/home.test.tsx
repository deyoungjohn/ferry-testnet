// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { SolverProvider } from '../lib/solver/SolverProvider';
import { StatsProvider } from '../lib/stats/StatsProvider';
import { MockWalletProvider } from '../lib/wallet/mock';

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <MockWalletProvider>
        <SolverProvider>
          <StatsProvider>
            <App />
          </StatsProvider>
        </SolverProvider>
      </MockWalletProvider>
    </MemoryRouter>,
  );
}

describe('home page', () => {
  it('renders the headline', () => {
    renderAt('/');

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: /move dollars onto bitcoin cash without a bridge/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders the swap card with an editable amount', () => {
    renderAt('/');

    expect(screen.getByRole('region', { name: 'Swap' })).toBeInTheDocument();
    expect(screen.getByText('You send')).toBeInTheDocument();
    expect(screen.getByText('You receive')).toBeInTheDocument();
    expect(screen.getByLabelText('You send amount')).toHaveValue('10.00');
    expect(screen.getByText('Mock solver')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /get quote/i }),
    ).toBeInTheDocument();
  });

  it('renders the complete page map and opens the honest-risk FAQ', () => {
    renderAt('/');

    expect(
      screen.getByRole('heading', { name: /what ferry has settled/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /recent swaps/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /a dollar target/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /two locks. one secret/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: /the honest version/i }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText(/what is the fast, or 0-conf, lane/i));
    expect(screen.getByText(/double-spend and reorg risk/i)).toBeVisible();
  });
});

describe('placeholder routes', () => {
  it('renders the recover page', async () => {
    renderAt('/recover');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /recover a swap/i,
      }),
    ).toBeInTheDocument();
  });

  it('renders the pay link page for an unknown link', async () => {
    renderAt('/p/link_123');

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: /link unavailable/i,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/pay link not found/i)).toBeInTheDocument();
  });
});
