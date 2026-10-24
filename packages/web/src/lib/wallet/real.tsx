import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';
import { useAppKit } from '@reown/appkit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WizardConnectQRDialog, useWizardConnect } from '@wizardconnect/react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Address, Hex, TypedDataDefinition } from 'viem';
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
  WagmiProvider,
} from 'wagmi';
import { addressFromPubkey } from '../bch/address';
import { FERRY_HTLC_ADDRESS, REOWN_PROJECT_ID, USDC_ADDRESS } from '../config';
import { WalletContext } from './context';
import { wagmiConfig } from './evm-config';
import { wizardConnectTheme } from './wizard-theme';
import type { BchWallet, EvmWallet } from './types';

const queryClient = new QueryClient();

const noncesAbi = [
  {
    type: 'function',
    name: 'nonces',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

function useRealEvmWallet(): EvmWallet {
  const { address, isConnected, isConnecting, isReconnecting } = useAccount();
  const { disconnectAsync } = useDisconnect();
  const { open } = useAppKit();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);

  return {
    status: !REOWN_PROJECT_ID
      ? 'unavailable'
      : isConnected
        ? 'connected'
        : isConnecting || isReconnecting
          ? 'connecting'
          : 'disconnected',
    address: address ?? null,
    error,
    connect: () => {
      if (!REOWN_PROJECT_ID) {
        setError('Wallet connect needs a Reown project ID');
        return;
      }
      void open();
    },
    disconnect: async () => {
      await disconnectAsync();
    },
    signTypedData: async (params: TypedDataDefinition) => {
      try {
        return await signTypedDataAsync(params as never);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Signature rejected');
        throw cause;
      }
    },
    readPermitNonce: async (owner: Address) => {
      if (!publicClient) throw new Error('Base RPC is not configured');
      return publicClient.readContract({
        address: USDC_ADDRESS,
        abi: noncesAbi,
        functionName: 'nonces',
        args: [owner],
      });
    },
    refundLock: async (id: Hex) => {
      return writeContractAsync({
        address: FERRY_HTLC_ADDRESS,
        abi: ferryHtlcAbi,
        functionName: 'refund',
        args: [id],
      });
    },
  };
}

function useRealBchWallet(): { wallet: BchWallet; dialog: ReactNode } {
  const wizard = useWizardConnect({ dappName: 'Ferry' });
  const [manualAddress, setManualAddress] =
    useState<BchWallet['address']>(null);
  const derived = useMemo(() => {
    if (wizard.state !== 'connected' || !wizard.manager) return null;
    const pubkey = wizard.manager.getPubkey(0, 0n);
    return pubkey ? addressFromPubkey(pubkey) : null;
  }, [wizard.state, wizard.manager]);

  const address = manualAddress ?? derived;

  useEffect(() => {
    if (!manualAddress && derived) setManualAddress(derived);
  }, [manualAddress, derived]);

  const wallet: BchWallet = {
    status:
      wizard.state === 'connected' && address
        ? 'connected'
        : wizard.state === 'connecting' || wizard.state === 'reconnecting'
          ? 'connecting'
          : 'disconnected',
    address,
    error: wizard.error,
    walletName: wizard.walletName,
    connect: () => {
      wizard.connect();
    },
    disconnect: async () => {
      setManualAddress(null);
      await wizard.disconnect();
    },
    setAddress: setManualAddress,
    broadcastTransaction: async () => {
      throw new Error('BCH broadcast is not wired in L5');
    },
  };

  const dialog =
    wizard.uri && wizard.qrUri ? (
      <WizardConnectQRDialog
        show={wizard.state === 'connecting'}
        onClose={() => {
          void wizard.disconnect();
        }}
        uri={wizard.uri}
        qrUri={wizard.qrUri}
        title="Connect a BCH wallet"
        subtitle="Scan with Selene, Paytaca or another WizardConnect wallet"
        theme={wizardConnectTheme}
      />
    ) : null;

  return { wallet, dialog };
}

const unavailableEvm: EvmWallet = {
  status: 'unavailable',
  address: null,
  error: 'Wallet connect needs a Reown project ID',
  connect: () => undefined,
  disconnect: async () => undefined,
  signTypedData: async () => {
    throw new Error('Wallet connect needs a Reown project ID');
  },
  readPermitNonce: async () => {
    throw new Error('Wallet connect needs a Reown project ID');
  },
  refundLock: async () => {
    throw new Error('Wallet connect needs a Reown project ID');
  },
};

function ConfiguredWalletSet({ children }: { readonly children: ReactNode }) {
  const evm = useRealEvmWallet();
  const { wallet: bch, dialog } = useRealBchWallet();

  return (
    <WalletContext.Provider value={{ evm, bch, usingMocks: false }}>
      {children}
      {dialog}
    </WalletContext.Provider>
  );
}

function UnconfiguredWalletSet({ children }: { readonly children: ReactNode }) {
  const { wallet: bch, dialog } = useRealBchWallet();

  return (
    <WalletContext.Provider
      value={{ evm: unavailableEvm, bch, usingMocks: false }}
    >
      {children}
      {dialog}
    </WalletContext.Provider>
  );
}

export function RealWalletProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {REOWN_PROJECT_ID ? (
          <ConfiguredWalletSet>{children}</ConfiguredWalletSet>
        ) : (
          <UnconfiguredWalletSet>{children}</UnconfiguredWalletSet>
        )}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
