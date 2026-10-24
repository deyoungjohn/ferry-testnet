import { useMemo, type ReactNode } from 'react';
import { MockWalletProvider } from './mock';
import { RealWalletProvider } from './real';

function useMockMode(): boolean {
  if (import.meta.env.VITE_USE_MOCKS === '1') return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mock') === '1';
}

export function WalletProvider({ children }: { readonly children: ReactNode }) {
  const mock = useMockMode();
  const provider = useMemo(
    () =>
      mock ? (
        <MockWalletProvider>{children}</MockWalletProvider>
      ) : (
        <RealWalletProvider>{children}</RealWalletProvider>
      ),
    [children, mock],
  );
  return provider;
}
