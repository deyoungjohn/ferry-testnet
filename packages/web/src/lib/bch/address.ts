import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  encodeLockingBytecodeP2pkh,
  hash160,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { BCH_CHAIN_NAME, BCH_PREFIX } from '../config';

export interface BchAddressInfo {
  readonly address: string;
  readonly lockingBytecode: `0x${string}`;
  readonly tokenAware: boolean;
}

export type BchAddressResult =
  | { readonly ok: true; readonly value: BchAddressInfo }
  | { readonly ok: false; readonly error: string };

export function parseBchAddress(input: string): BchAddressResult {
  const address = input.trim();
  if (!address) return { ok: false, error: 'Paste a BCH address' };
  if (!address.toLowerCase().startsWith(`${BCH_PREFIX}:`)) {
    return {
      ok: false,
      error: `Use a ${BCH_PREFIX}: address on ${BCH_CHAIN_NAME}`,
    };
  }

  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    return { ok: false, error: 'That address checksum is not valid' };
  }
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    return { ok: false, error: 'Use a P2PKH address that can receive tokens' };
  }
  if (decoded.type !== 'p2pkhWithTokens') {
    return {
      ok: false,
      error: `Use the token-aware address (it starts with ${BCH_PREFIX}:z)`,
    };
  }

  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') {
    return { ok: false, error: 'Could not decode that address' };
  }

  return {
    ok: true,
    value: {
      address,
      lockingBytecode: `0x${binToHex(locking.bytecode)}`,
      tokenAware: locking.tokenSupport,
    },
  };
}

export function parseBchAddressAnyNetwork(input: string): BchAddressResult {
  const address = input.trim();
  if (!address) return { ok: false, error: 'Paste a BCH address' };
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    return { ok: false, error: 'That address checksum is not valid' };
  }
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    return { ok: false, error: 'Use a P2PKH address that can receive tokens' };
  }
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') {
    return { ok: false, error: 'Could not decode that address' };
  }
  return {
    ok: true,
    value: {
      address,
      lockingBytecode: `0x${binToHex(locking.bytecode)}`,
      tokenAware: locking.tokenSupport,
    },
  };
}

export function addressFromPubkey(pubkey: Uint8Array): BchAddressInfo {
  const locking = encodeLockingBytecodeP2pkh(hash160(pubkey));
  const encoded = lockingBytecodeToCashAddress({
    bytecode: locking,
    prefix: BCH_PREFIX,
    tokenSupport: true,
  });
  if (typeof encoded === 'string') {
    throw new Error(`Could not encode BCH address: ${encoded}`);
  }
  return {
    address: encoded.address,
    lockingBytecode: `0x${binToHex(locking)}`,
    tokenAware: true,
  };
}

export function addressFromLockingBytecode(
  lockingBytecode: `0x${string}`,
): BchAddressInfo {
  const bytes = Uint8Array.from(
    lockingBytecode.slice(2).match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
  const encoded = lockingBytecodeToCashAddress({
    bytecode: bytes,
    prefix: BCH_PREFIX,
    tokenSupport: true,
  });
  if (typeof encoded === 'string') {
    throw new Error(`Could not encode BCH address: ${encoded}`);
  }
  return {
    address: encoded.address,
    lockingBytecode,
    tokenAware: true,
  };
}
