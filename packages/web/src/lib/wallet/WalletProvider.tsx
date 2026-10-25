import { lazy, Suspense, useMemo, type ReactNode } from 'react';
import { MockWalletProvider } from './mock';

const RealWalletProvider = lazy(async () => {
  const module = await import('./real');
  return { default: module.RealWalletProvider };
});

function useMockMode(): boolean {
  if (import.meta.env.VITE_USE_MOCKS === '1') return true;
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('mock') === '1';
}

function WalletLoading() {
  return (
    <div className="ferry-page grid min-h-dvh place-items-center">
      <p className="text-sm text-text-muted" role="status">
        Loading wallet…
      </p>
    </div>
  );
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
  return <Suspense fallback={<WalletLoading />}>{provider}</Suspense>;
}
