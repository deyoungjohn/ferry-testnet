// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  vi.stubEnv('VITE_NETWORK', 'mainnet');
  vi.resetModules();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  cleanup();
});

describe('active mainnet selection', () => {
  it('selects mainnet by the one build-time setting and fails closed', async () => {
    const config = await import('../lib/config');
    expect(config.NETWORK_KIND).toBe('mainnet');
    expect(config.NETWORK_LABEL).toBe('Mainnet');
    expect(config.NETWORK_CONFIG_ERRORS.length).toBeGreaterThan(0);
    expect(config.BASE_CHAIN_ID).toBe(8453);
    expect(config.BCH_NETWORK).toBe('mainnet');
    expect(config.BCH_PREFIX).toBe('bitcoincash');
    expect(config.PUSD_SYMBOL).toBe('PUSD');
    expect(config.PUSD_CATEGORY).toBe('');

    const { NetworkBlockedPage } =
      await import('../components/NetworkBlockedPage');
    render(<NetworkBlockedPage />);
    expect(
      screen.getByRole('heading', {
        name: /mainnet is not configured for real funds/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/mainnet profile is missing bch.pusdCategory/i),
    ).toBeInTheDocument();
  });

  it('blocks the app shell before any swap UI can render', async () => {
    const { AppShell } = await import('../components/AppShell');
    const { WalletContext } = await import('../lib/wallet/context');
    const { SolverProvider } = await import('../lib/solver/SolverProvider');
    const wallets = {
      usingMocks: false,
      evm: {
        status: 'disconnected',
        address: null,
        error: null,
        pendingRequest: null,
      },
      bch: {
        status: 'disconnected',
        address: null,
        error: null,
        walletName: null,
        pendingRequest: null,
      },
    } as never;
    render(
      <MemoryRouter>
        <WalletContext.Provider value={wallets}>
          <SolverProvider>
            <AppShell />
          </SolverProvider>
        </WalletContext.Provider>
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('heading', {
        name: /mainnet is not configured for real funds/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Swap' })).toBeNull();
    expect(
      screen.getByRole('alert', { name: 'Mainnet warning' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/mainnet — real funds/i)).toBeInTheDocument();
  });
});
