// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WalletPanel } from '../components/WalletPanel';
import { WalletContext } from '../lib/wallet/context';
import type { BchWallet, EvmWallet, WalletSet } from '../lib/wallet/types';

function walletSet(
  bch: Partial<BchWallet>,
  evm: Partial<EvmWallet>,
): WalletSet {
  return {
    usingMocks: false,
    bch: {
      status: 'disconnected',
      address: null,
      connect: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      setAddress: vi.fn(),
      ...bch,
    } as unknown as BchWallet,
    evm: {
      status: 'connected',
      address: '0xDF1e000000000000000000000000000000dc23ab',
      connect: vi.fn(),
      disconnect: vi.fn(async () => undefined),
      ...evm,
    } as unknown as EvmWallet,
  } as WalletSet;
}

function renderPanel(set: WalletSet) {
  return render(
    <WalletContext.Provider value={set}>
      <WalletPanel />
    </WalletContext.Provider>,
  );
}

describe(' wallet panel with the Base wallet already connected', () => {
  it('Connect BCH stays clickable and calls connect', () => {
    const set = walletSet({}, {});
    renderPanel(set);
    const button = screen.getByRole('button', { name: 'Connect BCH' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(set.bch.connect).toHaveBeenCalledTimes(1);
  });

  it('shows a cancel action while the BCH wallet is connecting, and cancelling disconnects', () => {
    const set = walletSet({ status: 'connecting' }, {});
    renderPanel(set);
    expect(
      screen.queryByRole('button', { name: 'Connect BCH' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /reconnecting bch/i }));
    expect(set.bch.disconnect).toHaveBeenCalledTimes(1);
  });

  it('shows the BCH connection error instead of failing silently', () => {
    const set = walletSet(
      { status: 'disconnected', error: 'Relay unreachable' },
      {},
    );
    renderPanel(set);
    expect(screen.getByRole('alert')).toHaveTextContent('Relay unreachable');
  });
});
