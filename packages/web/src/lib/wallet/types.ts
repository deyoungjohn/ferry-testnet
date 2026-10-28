import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { BchAddressInfo } from '../bch/address';

export type WalletStatus =
  'disconnected' | 'connecting' | 'connected' | 'offline' | 'unavailable';

export interface BchUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
  readonly lockingBytecode: `0x${string}`;
  readonly token?:
    | {
        readonly category: string;
        readonly amount: bigint;
      }
    | undefined;
}

export interface BchSourceOutput {
  readonly outpointIndex: number;
  readonly outpointTransactionHash: Uint8Array;
  readonly sequenceNumber: number;
  readonly unlockingBytecode: Uint8Array;
  readonly valueSatoshis: bigint;
  readonly lockingBytecode: Uint8Array;
  readonly token?:
    | {
        readonly category: Uint8Array;
        readonly amount: bigint;
      }
    | undefined;
}

export interface BchSignTransactionRequest {
  readonly transaction: string;
  readonly sourceOutputs: readonly BchSourceOutput[];
  readonly broadcast?: boolean;
  readonly userPrompt?: string;
}

export interface BchSignedTransaction {
  readonly txHex: string;
  readonly txid: string;
}

export interface EvmWallet {
  readonly status: WalletStatus;
  readonly address: Address | null;
  readonly error: string | null;
  readonly pendingRequest?: string | null;
  connect(): void;
  disconnect(): Promise<void>;
  signTypedData(params: TypedDataDefinition): Promise<Hex>;
  readPermitNonce(owner: Address): Promise<bigint>;
  refundLock(id: Hex): Promise<Hex>;
  claimLock(id: Hex, secret: Hex): Promise<Hex>;
}

export interface BchWallet {
  readonly status: WalletStatus;
  readonly address: BchAddressInfo | null;
  readonly error: string | null;
  readonly walletName: string | null;
  readonly pairing?: boolean;
  readonly pendingRequest?: string | null;
  connect(): void;
  disconnect(): Promise<void>;
  setAddress(address: BchAddressInfo): void;
  forget?(): void;
  signMessage?(message: string): Promise<string>;
  listUtxos(): Promise<readonly BchUtxo[]>;
  signTransaction(
    request: BchSignTransactionRequest,
  ): Promise<BchSignedTransaction>;
  broadcastTransaction(txHex: string): Promise<string>;
  transactionExists?(txid: string): Promise<boolean>;
}

export interface WalletSet {
  readonly evm: EvmWallet;
  readonly bch: BchWallet;
  readonly usingMocks: boolean;
}
