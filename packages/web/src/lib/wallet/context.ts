import { createContext, useContext } from 'react';
import type { WalletSet } from './types';

export const WalletContext = createContext<WalletSet | null>(null);

export function useWallets(): WalletSet {
  const value = useContext(WalletContext);
  if (!value) throw new Error('useWallets must be used inside WalletProvider');
  return value;
}
