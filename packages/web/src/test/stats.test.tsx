// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { SolverProvider } from '../lib/solver/SolverProvider';
import { createMockStatsClient } from '../lib/stats/mock';
import { StatsProvider } from '../lib/stats/StatsProvider';
import type { StatsClient } from '../lib/stats/types';
import { MockWalletProvider } from '../lib/wallet/mock';

function renderHome(client: StatsClient) {
  return render(
    <MemoryRouter>
      <MockWalletProvider>
        <SolverProvider>
          <StatsProvider client={client}>
            <App />
          </StatsProvider>
        </SolverProvider>
      </MockWalletProvider>
    </MemoryRouter>,
  );
}

describe('home live-data sections', () => {
  it('shows explicit empty states without fabricated metrics or charts', async () => {
    renderHome(createMockStatsClient());

    expect(await screen.findAllByText('No data yet')).toHaveLength(3);
    expect(
      screen.getByRole('heading', { level: 3, name: '0.4% spread' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no completed swaps yet/i)).toBeInTheDocument();
    expect(screen.getAllByText('No price yet')).toHaveLength(2);
    expect(
      screen.queryByRole('img', { name: /price over the last 24 hours/i }),
    ).not.toBeInTheDocument();
  });

  it('renders reported stats, settlement proofs and accessible peg series', async () => {
    const settledAt = 1_793_000_000;
    renderHome(
      createMockStatsClient({
        stats: {
          completedSwaps: 12,
          volumeUsdMicros: 1_234_560_000n,
          medianFastSeconds: 42,
          quotePolicy: {
            spreadBps: 55,
            fixedFeeUsdMicros: 70_000n,
          },
          asOf: settledAt,
        },
        recentSwaps: [
          {
            orderId: `0x${'11'.repeat(32)}`,
            settledAt,
            direction: 'COUNTER_TO_BCH',
            counterSymbol: 'USDC',
            counterDecimals: 6,
            counterAmount: 10_000_000n,
            bchSymbol: 'PUSD',
            bchDecimals: 2,
            bchTokenAmount: 991n,
            durationSeconds: 58,
            baseTxId: `0x${'22'.repeat(32)}`,
            bchTxId: '33'.repeat(32),
          },
        ],
        pegs: [
          {
            token: 'PUSD',
            priceUsdMicros: 1_001_000n,
            points: [
              { at: settledAt - 86_400, priceUsdMicros: 999_000n },
              { at: settledAt - 43_200, priceUsdMicros: 1_002_000n },
              { at: settledAt, priceUsdMicros: 1_001_000n },
            ],
            source: 'Test source',
            asOf: settledAt,
          },
          {
            token: 'MUSD',
            priceUsdMicros: 998_000n,
            points: [
              { at: settledAt - 86_400, priceUsdMicros: 997_000n },
              { at: settledAt - 43_200, priceUsdMicros: 999_000n },
              { at: settledAt, priceUsdMicros: 998_000n },
            ],
            source: 'Test source',
            asOf: settledAt,
          },
        ],
      }),
    );

    expect(await screen.findByText('$1,234.56')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: '0.55% spread' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('10 USDC → 9.91 PUSD')).not.toHaveLength(0);
    expect(
      screen.getAllByRole('link', { name: /Base transaction/i })[0],
    ).toHaveAttribute('href', expect.stringContaining('/tx/0x'));
    expect(
      screen.getByRole('img', {
        name: /PUSD price over the last 24 hours/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /MUSD price over the last 24 hours/i,
      }),
    ).toBeInTheDocument();
  });
});
