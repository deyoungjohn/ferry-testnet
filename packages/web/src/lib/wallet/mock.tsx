import { useMemo, useRef, useState, type ReactNode } from 'react';
import { keccak256, sha256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex, TypedDataDefinition } from 'viem';
import { parseBchAddress, parseBchAddressAnyNetwork } from '../bch/address';
import { MOCK_BCH_USER_ADDRESS, PUSD_CATEGORY } from '../config';
import { WalletContext } from './context';
import { sourceOutputToRelay } from './relay-format';
import { getScriptEvmBridge } from './script-evm';
import { getScriptWalletBridge } from './script-wallet';
import type {
  BchSignedTransaction,
  BchSignTransactionRequest,
  BchUtxo,
  BchWallet,
  EvmWallet,
  WalletStatus,
} from './types';

const mockUser = privateKeyToAccount(keccak256(toBytes('ferry.mock.user.v1')));

const mockBchResult = parseBchAddressAnyNetwork(MOCK_BCH_USER_ADDRESS);
if (!mockBchResult.ok) throw new Error(mockBchResult.error);
const mockBch = mockBchResult.value;

const MOCK_BCH_UTXOS: readonly BchUtxo[] = [
  {
    txid: '11'.repeat(32),
    vout: 0,
    satoshis: 10_000n,
    lockingBytecode: mockBch.lockingBytecode,
    token: { category: PUSD_CATEGORY, amount: 5_000n },
  },
];

export function MockWalletProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const initialQuery =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search);
  const [evmStatus, setEvmStatus] = useState<WalletStatus>('disconnected');
  const [bchStatus, setBchStatus] = useState<WalletStatus>(
    initialQuery?.get('bchOffline') === '1' ? 'offline' : 'disconnected',
  );
  const [evmPending, setEvmPending] = useState<string | null>(null);
  const query =
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search);
  const rejectSigning = query?.get('walletReject') === '1';
  const signingDelayMs = Number(query?.get('walletDelayMs') ?? 0);
  const claimBroadcastDelayMs = Number(
    query?.get('claimBroadcastDelayMs') ?? 0,
  );
  const claimBroadcastDuplicate = query?.get('claimBroadcastDuplicate') === '1';
  const claimConflict = query?.get('claimConflict') === '1';
  const claimSpentButKnown = query?.get('claimSpentButKnown') === '1';
  const broadcastCount = useRef(0);
  const scriptEvm = useMemo(() => getScriptEvmBridge(), []);
  const scriptWallet = useMemo(() => getScriptWalletBridge(), []);
  const scriptBch = useMemo(() => {
    if (!scriptWallet) return null;
    const parsed = parseBchAddress(scriptWallet.address);
    if (!parsed.ok) {
      throw new Error(`Script wallet address is invalid: ${parsed.error}`);
    }
    return parsed.value;
  }, [scriptWallet]);

  const evm = useMemo<EvmWallet>(
    () => ({
      status: evmStatus,
      address:
        evmStatus === 'connected'
          ? ((scriptEvm?.address as Address) ?? mockUser.address)
          : null,
      error: null,
      pendingRequest: evmPending,
      connect: () => {
        setEvmStatus('connected');
      },
      disconnect: async () => {
        setEvmStatus('disconnected');
      },
      signTypedData: async (params: TypedDataDefinition) => {
        setEvmPending(
          params.primaryType === 'Permit'
            ? 'Sign the USDC permit'
            : 'Sign the lock intent',
        );
        try {
          if (signingDelayMs > 0) {
            await new Promise((resolve) =>
              window.setTimeout(resolve, signingDelayMs),
            );
          }
          if (rejectSigning) {
            throw new Error('User rejected the request.');
          }
          if (scriptEvm) {
            const wire = JSON.stringify(params, (_key, value) =>
              typeof value === 'bigint' ? `<bigint: ${value}n>` : value,
            );
            return (await scriptEvm.signTypedData(wire)) as Hex;
          }
          return mockUser.signTypedData(params as never);
        } finally {
          setEvmPending(null);
        }
      },
      readPermitNonce: async () =>
        scriptEvm ? BigInt(await scriptEvm.readPermitNonce()) : 0n,
      refundLock: async (id: Hex) => sha256(id),
      claimLock: async (id: Hex) => sha256(id),
    }),
    [evmStatus, evmPending, rejectSigning, scriptEvm, signingDelayMs],
  );

  const bch = useMemo<BchWallet>(
    () => ({
      status: bchStatus,
      address:
        bchStatus === 'connected' || bchStatus === 'offline'
          ? (scriptBch ?? mockBch)
          : null,
      error: null,
      walletName:
        bchStatus === 'connected' || bchStatus === 'offline'
          ? scriptWallet
            ? 'Script test wallet'
            : 'Paytaca'
          : null,
      pendingRequest: null,
      connect: () => {
        setBchStatus('connected');
      },
      disconnect: async () => {
        setBchStatus('disconnected');
      },
      setAddress: () => {
        setBchStatus('connected');
      },
      forget: () => {
        setBchStatus('disconnected');
      },
      listUtxos: async () => {
        if (!scriptWallet) return MOCK_BCH_UTXOS;
        const utxos = await scriptWallet.listUtxos();
        return utxos.map((utxo) => ({
          txid: utxo.txid,
          vout: utxo.vout,
          satoshis: BigInt(utxo.satoshis),
          lockingBytecode: utxo.lockingBytecode as `0x${string}`,
          ...(utxo.token
            ? {
                token: {
                  category: utxo.token.category.startsWith('0x')
                    ? utxo.token.category
                    : `0x${utxo.token.category}`,
                  amount: BigInt(utxo.token.amount),
                },
              }
            : {}),
        }));
      },
      signTransaction: async (
        request: BchSignTransactionRequest,
      ): Promise<BchSignedTransaction> => {
        if (!scriptWallet) {
          return {
            txHex: request.transaction,
            txid: sha256(
              (request.transaction.startsWith('0x')
                ? request.transaction
                : `0x${request.transaction}`) as Hex,
            ),
          };
        }
        const signed = await scriptWallet.sign({
          transaction: request.transaction,
          sourceOutputs: request.sourceOutputs.map(sourceOutputToRelay),
          broadcast: request.broadcast ?? false,
          userPrompt: request.userPrompt ?? 'Sign the BCH funding request',
        });
        if (!signed) throw new Error('The script wallet rejected the request');
        return {
          txHex: signed.signedTransaction,
          txid: signed.signedTransactionHash,
        };
      },
      broadcastTransaction: async (txHex: string) => {
        if (scriptWallet) return scriptWallet.broadcast(txHex);
        if (claimBroadcastDelayMs > 0) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, claimBroadcastDelayMs),
          );
        }
        broadcastCount.current += 1;
        if (claimConflict || claimSpentButKnown) {
          throw new Error('bad-txns-inputs-missingorspent');
        }
        if (claimBroadcastDuplicate && broadcastCount.current === 1) {
          throw new Error('transaction already in block chain');
        }
        return sha256((txHex.startsWith('0x') ? txHex : `0x${txHex}`) as Hex);
      },
      transactionExists: async () => claimSpentButKnown,
      signMessage: async (message: string) => sha256(toBytes(message)),
    }),
    [
      bchStatus,
      claimBroadcastDelayMs,
      claimBroadcastDuplicate,
      claimConflict,
      claimSpentButKnown,
      scriptBch,
      scriptWallet,
    ],
  );

  return (
    <WalletContext.Provider value={{ evm, bch, usingMocks: true }}>
      {children}
    </WalletContext.Provider>
  );
}
