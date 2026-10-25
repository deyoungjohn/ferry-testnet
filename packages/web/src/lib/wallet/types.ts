import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { BchAddressInfo } from '../bch/address';

export type WalletStatus =
  'disconnected' | 'connecting' | 'connected' | 'unavailable';

export interface EvmWallet {
  readonly status: WalletStatus;
  readonly address: Address | null;
  readonly error: string | null;
  connect(): void;
  disconnect(): Promise<void>;
  signTypedData(params: TypedDataDefinition): Promise<Hex>;
  readPermitNonce(owner: Address): Promise<bigint>;
  refundLock(id: Hex): Promise<Hex>;
}

export interface BchWallet {
  readonly status: WalletStatus;
  readonly address: BchAddressInfo | null;
  readonly error: string | null;
  readonly walletName: string | null;
  connect(): void;
  disconnect(): Promise<void>;
  setAddress(address: BchAddressInfo): void;
  broadcastTransaction(txHex: string): Promise<string>;
}

export interface WalletSet {
  readonly evm: EvmWallet;
  readonly bch: BchWallet;
  readonly usingMocks: boolean;
}
