export type CashAddressNetwork = 'chipnet' | 'mainnet';

export interface BchHtlcParameters {
  hashLock: Uint8Array; // 32-byte sha256(secret)
  recipientLockingBytecode: Uint8Array; // P2PKH locking bytecode
  refundLockingBytecode: Uint8Array; // P2PKH locking bytecode
  tokenCategory: Uint8Array; // 32 bytes in INTERNAL byte order
  tokenAmount: bigint; // base units (e.g. 2 decimals for PUSD/MUSD)
  refundHeight: number; // absolute block height (< 500,000,000)
  maxFee: bigint; // max sats the spend may burn as miner fee (e.g. 1500)
}

export interface HtlcInputTerms {
  // Either 32-byte secret or pre-computed hashLock
  secret?: Uint8Array | string;
  hashLock?: Uint8Array | string;

  // Payee & Refunder: either CashAddress string or raw lockingBytecode
  recipientAddress?: string;
  recipientLockingBytecode?: Uint8Array | string;

  refundAddress?: string;
  refundLockingBytecode?: Uint8Array | string;

  // Category in display (RPC) hex or internal byte order
  tokenCategory: string | Uint8Array;
  tokenCategoryIsInternal?: boolean;

  tokenAmount: bigint | number;
  refundHeight: number;
  maxFee?: bigint | number; // defaults to 1500n
}

export interface HtlcAddressDerivationResult {
  p2sh32Address: string; // bchtest:p... or bitcoincash:p...
  tokenAddress: string; // bchtest:r... or bitcoincash:r...
  redeemScript: Uint8Array;
  lockingBytecode: Uint8Array;
}
