// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { NavBar } from '../components/NavBar';
import { WalletActivityBanner } from '../components/WalletActivityBanner';
import { WalletContext } from '../lib/wallet/context';
import type { BchWallet, EvmWallet, WalletSet } from '../lib/wallet/types';

const baseBch: BchWallet = {
  status: 'disconnected',
  address: null,
  error: null,
  walletName: null,
  connect: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  setAddress: vi.fn(),
  listUtxos: vi.fn(async () => []),
  signTransaction: vi.fn(),
  broadcastTransaction: vi.fn(),
};

const baseEvm: EvmWallet = {
  status: 'disconnected',
  address: null,
  error: null,
  connect: vi.fn(),
  disconnect: vi.fn(async () => undefined),
  signTypedData: vi.fn(),
  readPermitNonce: vi.fn(),
  refundLock: vi.fn(),
  claimLock: vi.fn(),
};

function set(overrides: Partial<WalletSet> = {}): WalletSet {
  return {
    usingMocks: false,
    bch: baseBch,
    evm: baseEvm,
    ...overrides,
  };
}

function renderNav(context: WalletSet) {
  return render(
    <MemoryRouter>
      <WalletContext.Provider value={context}>
        <NavBar />
      </WalletContext.Provider>
    </MemoryRouter>,
  );
}

describe(' global wallet state', () => {
  it('shows Connect when neither wallet is connected', () => {
    renderNav(set());
    expect(
      screen.getByRole('button', { name: /wallet connection: connect/i }),
    ).toHaveTextContent('Connect');
  });

  it('shows a partial state when only one wallet is connected', () => {
    renderNav(
      set({
        bch: {
          ...baseBch,
          status: 'connected',
          address: {
            address: 'bchtest:zznldca5825k6le8hpnwxhzugn82j2gm8uzgy6y6j8',
            lockingBytecode: '0x00',
            tokenAware: true,
          },
        },
      }),
    );
    expect(
      screen.getByRole('button', {
        name: /wallet connection: 1 of 2 wallets/i,
      }),
    ).toHaveTextContent('1 of 2 wallets');
  });

  it('shows the connected EVM address when both wallets are connected', () => {
    renderNav(
      set({
        bch: {
          ...baseBch,
          status: 'connected',
          address: {
            address: 'bchtest:zznldca5825k6le8hpnwxhzugn82j2gm8uzgy6y6j8',
            lockingBytecode: '0x00',
            tokenAware: true,
          },
        },
        evm: {
          ...baseEvm,
          status: 'connected',
          address: '0xDF1e000000000000000000000000000000dc23ab',
        },
      }),
    );
    expect(
      screen.getByRole('button', { name: /wallet connection: 0xDF1e…23ab/i }),
    ).toBeVisible();
  });

  it('surfaces the named pending wallet request', () => {
    render(
      <WalletContext.Provider
        value={set({
          evm: { ...baseEvm, pendingRequest: 'Sign the USDC permit' },
        })}
      >
        <WalletActivityBanner />
      </WalletContext.Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /Waiting for your wallet: Sign the USDC permit/i,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      /open your wallet extension/i,
    );
  });
});
