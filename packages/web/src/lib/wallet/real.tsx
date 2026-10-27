import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';
import { useAppKit } from '@reown/appkit/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { clearSession } from '@wizardconnect/dapp';
import { WizardConnectQRDialog, useWizardConnect } from '@wizardconnect/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  bytesToHex,
  hexToBytes,
  sha256,
  type Address,
  type Hex,
  type TypedDataDefinition,
} from 'viem';
import {
  useAccount,
  useDisconnect,
  usePublicClient,
  useSignTypedData,
  useWriteContract,
  WagmiProvider,
} from 'wagmi';
import { addressFromPubkey } from '../bch/address';
import {
  BASE_CHAIN_ID,
  BCH_ELECTRUM_URL,
  FERRY_HTLC_ADDRESS,
  REOWN_PROJECT_ID,
  USDC_ADDRESS,
} from '../config';
import { ElectrumClient } from '../../recover/core';
import { WalletContext } from './context';
import { wagmiConfig } from './evm-config';
import { buildInputPaths, sourceOutputToRelay } from './relay-format';
import {
  WalletSignedTransactionError,
  inspectSignedTransaction,
} from './signed-check';
import { wizardConnectTheme } from './wizard-theme';
import { useBchReconnectTimeout } from './reconnect-timeout';
import { isWrongEvmChain, wrongEvmChainMessage } from './chain';
import {
  clearRememberedBchWallet,
  readRememberedBchWallet,
  saveRememberedBchWallet,
  type RememberedBchWallet,
} from './remembered';
import type {
  BchSignedTransaction,
  BchSignTransactionRequest,
  BchUtxo,
  BchWallet,
  EvmWallet,
} from './types';

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
  const { address, chainId, isConnected, isConnecting, isReconnecting } =
    useAccount();
  const wrongChain = isConnected && isWrongEvmChain(chainId, BASE_CHAIN_ID);
  const { disconnectAsync } = useDisconnect();
  const { open } = useAppKit();
  const { signTypedDataAsync } = useSignTypedData();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [error, setError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);

  return {
    status: !REOWN_PROJECT_ID
      ? 'unavailable'
      : wrongChain
        ? 'disconnected'
        : isConnected
          ? 'connected'
          : isConnecting || isReconnecting
            ? 'connecting'
            : 'disconnected',
    address: wrongChain ? null : (address ?? null),
    error: error ?? (wrongChain ? wrongEvmChainMessage(BASE_CHAIN_ID) : null),
    pendingRequest,
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
      setPendingRequest(
        params.primaryType === 'Permit'
          ? 'Sign the USDC permit'
          : 'Sign the lock intent',
      );
      try {
        return await signTypedDataAsync(params as never);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Signature rejected');
        throw cause;
      } finally {
        setPendingRequest(null);
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
      setPendingRequest('Confirm the USDC refund');
      try {
        return await writeContractAsync({
          address: FERRY_HTLC_ADDRESS,
          abi: ferryHtlcAbi,
          functionName: 'refund',
          args: [id],
        });
      } finally {
        setPendingRequest(null);
      }
    },
    claimLock: async (id: Hex, secret: Hex) => {
      setPendingRequest('Confirm the USDC claim');
      try {
        return await writeContractAsync({
          address: FERRY_HTLC_ADDRESS,
          abi: ferryHtlcAbi,
          functionName: 'claim',
          args: [id, secret],
        });
      } finally {
        setPendingRequest(null);
      }
    },
  };
}

function txidOf(txHex: string): string {
  const first = hexToBytes(
    sha256((txHex.startsWith('0x') ? txHex : `0x${txHex}`) as Hex),
  );
  const second = hexToBytes(sha256(first));
  second.reverse();
  return bytesToHex(second).slice(2);
}

function useRealBchWallet(
  onRestart: () => void,
  startFresh: boolean,
): { wallet: BchWallet; dialog: ReactNode } {
  const wizard = useWizardConnect({ dappName: 'Ferry' });
  const connectRef = useRef(wizard.connect);
  const startedFresh = useRef(false);
  useEffect(() => {
    connectRef.current = wizard.connect;
  }, [wizard.connect]);
  useEffect(() => {
    if (!startFresh || startedFresh.current) return;
    startedFresh.current = true;
    const timer = window.setTimeout(() => connectRef.current(), 0);
    return () => window.clearTimeout(timer);
  }, [startFresh]);
  const reconnectTimedOut = useBchReconnectTimeout(wizard.state, () =>
    wizard.disconnect(),
  );
  const [pendingRequest, setPendingRequest] = useState<string | null>(null);
  const [remembered, setRemembered] = useState<RememberedBchWallet | null>(() =>
    readRememberedBchWallet(),
  );
  const [manualAddress, setManualAddress] =
    useState<BchWallet['address']>(null);
  const derived = useMemo(() => {
    if (wizard.state !== 'connected' || !wizard.manager) return null;
    const pubkey = wizard.manager.getPubkey(0, 0n);
    return pubkey ? addressFromPubkey(pubkey) : null;
  }, [wizard.state, wizard.manager]);

  const derivedChange = useMemo(() => {
    if (wizard.state !== 'connected' || !wizard.manager) return null;
    const pubkey = wizard.manager.getPubkey(1, 0n);
    return pubkey ? addressFromPubkey(pubkey) : null;
  }, [wizard.state, wizard.manager]);

  const address = manualAddress ?? derived ?? remembered?.address ?? null;

  useEffect(() => {
    if (!manualAddress && derived) setManualAddress(derived);
  }, [manualAddress, derived]);

  useEffect(() => {
    if (wizard.state !== 'connected' || !derived) return;
    const next = saveRememberedBchWallet(wizard.walletName, derived);
    setRemembered(next);
  }, [derived, wizard.state, wizard.walletName]);

  const wallet: BchWallet = {
    status:
      wizard.state === 'connected' && address
        ? 'connected'
        : !reconnectTimedOut &&
            (wizard.state === 'connecting' || wizard.state === 'reconnecting')
          ? 'connecting'
          : remembered
            ? 'offline'
            : 'disconnected',
    address,
    error: wizard.error,
    pendingRequest,
    walletName: wizard.walletName ?? remembered?.name ?? null,
    connect: () => {
      // A fresh pairing must supersede a stale restored attempt without waiting
      // for its relay disconnect. Clear the stored session and remount the
      // WizardConnect hook; the new mount opens a fresh QR dialog.
      onRestart();
    },
    disconnect: async () => {
      setManualAddress(null);
      await wizard.disconnect();
    },
    setAddress: (next) => {
      setManualAddress(next);
      setRemembered(saveRememberedBchWallet(wizard.walletName, next));
    },
    forget: () => {
      clearRememberedBchWallet();
      setRemembered(null);
      setManualAddress(null);
      void wizard.disconnect();
    },
    listUtxos: async (): Promise<readonly BchUtxo[]> => {
      if (!address) throw new Error('Connect a BCH wallet first');
      const owned = [
        address,
        ...(derivedChange && derivedChange.address !== address.address
          ? [derivedChange]
          : []),
      ];
      const electrum = new ElectrumClient(BCH_ELECTRUM_URL);
      try {
        await electrum.connect();
        const lists = await Promise.all(
          owned.map((ownedAddress) =>
            electrum.listUnspent(ownedAddress.lockingBytecode),
          ),
        );
        return lists.flatMap((utxos, index) => {
          const ownedAddress = owned[index];
          if (!ownedAddress) return [];
          return utxos.map((utxo) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            satoshis: utxo.satoshis,
            lockingBytecode: ownedAddress.lockingBytecode,
            ...(utxo.category !== null && utxo.amount !== null
              ? {
                  token: {
                    category: `0x${utxo.category.replace(/^0x/, '')}`,
                    amount: utxo.amount,
                  },
                }
              : {}),
          }));
        });
      } finally {
        electrum.close();
      }
    },
    signTransaction: async (
      request: BchSignTransactionRequest,
    ): Promise<BchSignedTransaction> => {
      if (!wizard.manager)
        throw new Error('Connect a WizardConnect wallet first');
      setPendingRequest(request.userPrompt ?? 'Sign the BCH transaction');
      try {
        const response = await wizard.manager.signTransaction({
          transaction: {
            transaction: request.transaction,
            // JSON transport: bigint and bytes must use the relay wire format.
            sourceOutputs: request.sourceOutputs.map(
              sourceOutputToRelay,
            ) as never,
            ...(request.broadcast !== undefined
              ? { broadcast: request.broadcast }
              : {}),
            ...(request.userPrompt !== undefined
              ? { userPrompt: request.userPrompt }
              : {}),
          },
          inputPaths: buildInputPaths(
            request.sourceOutputs,
            derived?.lockingBytecode,
            derivedChange?.lockingBytecode,
          ),
        });
        const txHex = response.signedTransaction;
        const report = inspectSignedTransaction(
          request.transaction,
          txHex,
          request.sourceOutputs,
        );
        if (!report.ok) {
          console.error(
            'Wallet returned a transaction that fails the local check',
            report.diagnostic,
          );
          throw new WalletSignedTransactionError(report);
        }
        return { txHex, txid: txidOf(txHex) };
      } finally {
        setPendingRequest(null);
      }
    },
    broadcastTransaction: async (txHex: string) => {
      const electrum = new ElectrumClient(BCH_ELECTRUM_URL);
      try {
        await electrum.connect();
        return await electrum.broadcast(txHex);
      } finally {
        electrum.close();
      }
    },
    transactionExists: async (txid: string) => {
      const electrum = new ElectrumClient(BCH_ELECTRUM_URL);
      try {
        await electrum.connect();
        return await electrum.transactionExists(txid);
      } finally {
        electrum.close();
      }
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
  pendingRequest: null,
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
  claimLock: async () => {
    throw new Error('Wallet connect needs a Reown project ID');
  },
};

function BchWalletSession({
  evm,
  startFresh,
  onRestart,
  children,
}: {
  readonly evm: EvmWallet;
  readonly startFresh: boolean;
  readonly onRestart: () => void;
  readonly children: ReactNode;
}) {
  const { wallet: bch, dialog } = useRealBchWallet(onRestart, startFresh);

  return (
    <WalletContext.Provider value={{ evm, bch, usingMocks: false }}>
      {children}
      {dialog}
    </WalletContext.Provider>
  );
}

export function BchWalletHost({
  evm,
  children,
}: {
  readonly evm: EvmWallet;
  readonly children: ReactNode;
}) {
  const [nonce, setNonce] = useState(0);
  const [startFresh, setStartFresh] = useState(false);
  const restart = () => {
    clearSession();
    setStartFresh(true);
    setNonce((current) => current + 1);
  };

  return (
    <BchWalletSession
      key={nonce}
      evm={evm}
      startFresh={startFresh}
      onRestart={restart}
    >
      {children}
    </BchWalletSession>
  );
}

function ConfiguredWalletSet({ children }: { readonly children: ReactNode }) {
  const evm = useRealEvmWallet();

  return <BchWalletHost evm={evm}>{children}</BchWalletHost>;
}

function UnconfiguredWalletSet({ children }: { readonly children: ReactNode }) {
  return <BchWalletHost evm={unavailableEvm}>{children}</BchWalletHost>;
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
