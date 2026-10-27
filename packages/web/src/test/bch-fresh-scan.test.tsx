// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvmWallet } from '../lib/wallet/types';

const wizardCalls = {
  mounts: 0,
  connects: 0,
};

vi.mock('@wizardconnect/react', () => {
  return {
    useWizardConnect: () => {
      wizardCalls.mounts += 1;
      return {
        state: 'reconnecting',
        manager: null,
        uri: null,
        qrUri: null,
        walletName: 'Paytaca',
        walletIcon: null,
        error: null,
        connect: () => {
          wizardCalls.connects += 1;
          return true;
        },
        disconnect: () => new Promise(() => undefined),
      };
    },
    WizardConnectQRDialog: () => null,
  };
});

const evm = {
  status: 'disconnected',
  address: null,
  error: null,
  pendingRequest: null,
} as EvmWallet;

beforeEach(() => {
  wizardCalls.mounts = 0;
  wizardCalls.connects = 0;
  window.localStorage.setItem('wizardconnect-session', 'stale');
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('fresh BCH scan supersedes a stale restored attempt', () => {
  it('remounts and opens a fresh pairing without waiting for the stale disconnect', async () => {
    const { BchWalletHost } = await import('../lib/wallet/real');
    const { useWallets } = await import('../lib/wallet/context');

    function ConnectButton() {
      const { bch } = useWallets();
      return (
        <button type="button" onClick={() => bch.connect()}>
          Fresh scan
        </button>
      );
    }

    render(
      <BchWalletHost evm={evm}>
        <ConnectButton />
      </BchWalletHost>,
    );

    expect(wizardCalls.mounts).toBe(1);
    screen.getByRole('button', { name: 'Fresh scan' }).click();
    await screen.findByRole('button', { name: 'Fresh scan' });

    expect(wizardCalls.mounts).toBeGreaterThanOrEqual(2);
    expect(wizardCalls.connects).toBeGreaterThanOrEqual(1);
    expect(window.localStorage.getItem('wizardconnect-session')).toBeNull();
  });
});
