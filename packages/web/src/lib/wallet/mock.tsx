import { useMemo, useState, type ReactNode } from 'react';
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
  const [evmStatus, setEvmStatus] = useState<WalletStatus>('disconnected');
  const [bchStatus, setBchStatus] = useState<WalletStatus>('disconnected');

  const evm = useMemo<EvmWallet>(
    () => ({
      status: evmStatus,
      address: evmStatus === 'connected' ? mockUser.address : null,
      error: null,
      connect: () => {
        setEvmStatus('connected');
      },
      disconnect: async () => {
        setEvmStatus('disconnected');
      },
      signTypedData: async (params: TypedDataDefinition) =>
        mockUser.signTypedData(params as never),
      readPermitNonce: async () => 0n,
      refundLock: async (id: Hex) => sha256(id),
      claimLock: async (id: Hex) => sha256(id),
    }),
    [evmStatus],
  );

  const bch = useMemo<BchWallet>(
    () => ({
      status: bchStatus,
      address: bchStatus === 'connected' ? mockBch : null,
      error: null,
      walletName: bchStatus === 'connected' ? 'Mock BCH wallet' : null,
      connect: () => {
        setBchStatus('connected');
      },
      disconnect: async () => {
        setBchStatus('disconnected');
      },
      setAddress: () => {
        setBchStatus('connected');
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
      broadcastTransaction: async (txHex: string) =>
        sha256((txHex.startsWith('0x') ? txHex : `0x${txHex}`) as Hex),
    }),
    [bchStatus],
  );

  return (
    <WalletContext.Provider value={{ evm, bch, usingMocks: true }}>
      {children}
    </WalletContext.Provider>
  );
}
