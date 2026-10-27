import { createAppKit } from '@reown/appkit/react';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { createConfig, http } from 'wagmi';
import { base, baseSepolia } from 'wagmi/chains';
import type { ChainAdapter } from '@reown/appkit';
import type { AppKitNetwork } from '@reown/appkit/networks';
import {
  BASE_CHAIN_ID,
  BASE_RPC_URL,
  FERRY_HTLC_ADDRESS,
  IS_MAINNET,
  REOWN_PROJECT_ID,
} from '../config';

const activeChain = IS_MAINNET ? base : baseSepolia;
const transport = BASE_RPC_URL ? http(BASE_RPC_URL) : http();
const networks = [activeChain] as unknown as [
  AppKitNetwork,
  ...AppKitNetwork[],
];

if (activeChain.id !== BASE_CHAIN_ID) {
  throw new Error(
    `Wallet chain ${activeChain.id.toString()} does not match the ${IS_MAINNET ? 'mainnet' : 'testnet'} profile (${BASE_CHAIN_ID.toString()})`,
  );
}

export const wagmiAdapter = REOWN_PROJECT_ID
  ? new WagmiAdapter({
      networks,
      projectId: REOWN_PROJECT_ID,
      transports: {
        [activeChain.id]: transport,
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
    defaultNetwork: activeChain,
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
    chains: [activeChain] as never,
    transports: {
      [activeChain.id]: transport,
    } as never,
  });

export const ferryHtlcAddress = FERRY_HTLC_ADDRESS;
