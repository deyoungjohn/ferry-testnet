import { useMemo, useRef, useState, type ReactNode } from 'react';
import { keccak256, sha256, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, TypedDataDefinition } from 'viem';
import { parseBchAddress } from '../bch/address';
import { MOCK_BCH_USER_ADDRESS, PUSD_CATEGORY } from '../config';
import { WalletContext } from './context';
import type {
  BchSignedTransaction,
  BchSignTransactionRequest,
  BchUtxo,
  BchWallet,
  EvmWallet,
  WalletStatus,
} from './types';

const mockUser = privateKeyToAccount(keccak256(toBytes('ferry.mock.user.v1')));

const mockBchResult = parseBchAddress(MOCK_BCH_USER_ADDRESS);
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

  const evm = useMemo<EvmWallet>(
    () => ({
      status: evmStatus,
      address: evmStatus === 'connected' ? mockUser.address : null,
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
          return mockUser.signTypedData(params as never);
        } finally {
          setEvmPending(null);
        }
      },
      readPermitNonce: async () => 0n,
      refundLock: async (id: Hex) => sha256(id),
      claimLock: async (id: Hex) => sha256(id),
    }),
    [evmStatus, evmPending, rejectSigning, signingDelayMs],
  );

  const bch = useMemo<BchWallet>(
    () => ({
      status: bchStatus,
      address:
        bchStatus === 'connected' || bchStatus === 'offline' ? mockBch : null,
      error: null,
      walletName:
        bchStatus === 'connected' || bchStatus === 'offline' ? 'Paytaca' : null,
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
      listUtxos: async () => MOCK_BCH_UTXOS,
      signTransaction: async (
        request: BchSignTransactionRequest,
      ): Promise<BchSignedTransaction> => ({
        txHex: request.transaction,
        txid: sha256(
          (request.transaction.startsWith('0x')
            ? request.transaction
            : `0x${request.transaction}`) as Hex,
        ),
      }),
      broadcastTransaction: async (txHex: string) => {
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
    ],
  );

  return (
    <WalletContext.Provider value={{ evm, bch, usingMocks: true }}>
      {children}
    </WalletContext.Provider>
  );
}
