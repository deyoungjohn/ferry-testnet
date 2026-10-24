import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createConfig, http } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import type { ChainAdapter } from '@reown/appkit';
import type { AppKitNetwork } from '@reown/appkit/networks';
import {
  BASE_SEPOLIA_RPC_URL,
  FERRY_HTLC_ADDRESS,
  REOWN_PROJECT_ID,
} from '../config';

const networks = [baseSepolia] as unknown as [
  AppKitNetwork,
  ...AppKitNetwork[],
];

export const wagmiAdapter = REOWN_PROJECT_ID
  ? new WagmiAdapter({
      networks,
      projectId: REOWN_PROJECT_ID,
      transports: {
        [baseSepolia.id]: http(BASE_SEPOLIA_RPC_URL),
      },
    })
  : null;

if (wagmiAdapter) {
  createAppKit({
    adapters: [wagmiAdapter as unknown as ChainAdapter],
    networks,
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: 'Ferry',
      description: 'Move dollars onto Bitcoin Cash without a bridge.',
      url: 'https://ferry.local',
      icons: [],
    },
    defaultNetwork: baseSepolia,
    features: {
      analytics: false,
      email: false,
      socials: false,
      swaps: false,
      onramp: false,
    },
    themeMode: 'dark',
    themeVariables: {
      '--w3m-accent': '#c6f219',
      '--w3m-border-radius-master': '999px',
    },
  });
}

export const wagmiConfig =
  wagmiAdapter?.wagmiConfig ??
  createConfig({
    chains: [baseSepolia],
    transports: {
      [baseSepolia.id]: http(BASE_SEPOLIA_RPC_URL),
    },
  });

export const ferryHtlcAddress = FERRY_HTLC_ADDRESS;
