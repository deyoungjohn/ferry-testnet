import crypto from 'node:crypto';
import {
  decodePrivateKeyWif,
  encodePrivateKeyWif,
  encodeCashAddress,
  CashAddressType,
  secp256k1,
  sha256,
  ripemd160,
} from '@bitauth/libauth';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import type { BchAddressInfo } from './types.js';

export type CashAddressNetworkPrefix = 'bchtest' | 'bitcoincash' | 'bchreg';

/**
 * Generate a random 32-byte private key.
 */
export function generateRandomPrivateKey(): Uint8Array {
  return Uint8Array.from(crypto.randomBytes(32));
}

/**
 * Generate a new BCH testnet/chipnet WIF key.
 */
export function generateBchTestnetWif(): string {
  const privKey = generateRandomPrivateKey();
  return encodePrivateKeyWif(privKey, 'testnet');
}

/**
 * Generate a new EVM private key hex string (0x-prefixed, 32 bytes).
 */
export function generateEvmPrivateKey(): `0x${string}` {
  const bytes = crypto.randomBytes(32);
  return `0x${bytes.toString('hex')}`;
}

/**
 * Validate a BCH WIF string.
 */
export function isValidBchWif(wif: string): boolean {
  const trimmed = wif.trim();
  if (!trimmed) return false;
  const decoded = decodePrivateKeyWif(trimmed);
  if (typeof decoded === 'string') return false;
  const pubKey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  return typeof pubKey !== 'string';
}

/**
 * Validate an EVM private key hex string.
 */
export function isValidEvmPrivateKey(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  const formatted = (
    trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  ) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(formatted)) return false;
  try {
    privateKeyToAccount(formatted);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive BCH CashAddresses (plain P2PKH and token-aware P2PKH) from a public key hash.
 * @param pkh 20-byte public key hash
 * @param prefix CashAddress prefix (default 'bchtest')
 */
export function deriveBchAddressesFromPkh(
  pkh: Uint8Array,
  prefix: CashAddressNetworkPrefix = 'bchtest',
): BchAddressInfo {
  const plainRes = encodeCashAddress({
    prefix,
    type: CashAddressType.p2pkh,
    payload: pkh,
  });
  if (typeof plainRes === 'string') {
    throw new Error(`Failed to encode plain CashAddress: ${plainRes}`);
  }

  const tokenRes = encodeCashAddress({
    prefix,
    type: CashAddressType.p2pkhWithTokens,
    payload: pkh,
  });
  if (typeof tokenRes === 'string') {
    throw new Error(`Failed to encode token-aware CashAddress: ${tokenRes}`);
  }

  return {
    plain: plainRes.address,
    tokenAware: tokenRes.address,
  };
}

/**
 * Derive BCH CashAddresses from a compressed public key.
 */
export function deriveBchAddressesFromPubKey(
  pubKey: Uint8Array,
  prefix: CashAddressNetworkPrefix = 'bchtest',
): BchAddressInfo {
  const pkh = ripemd160.hash(sha256.hash(pubKey));
  return deriveBchAddressesFromPkh(pkh, prefix);
}

/**
 * Derive BCH CashAddresses from a WIF string.
 */
export function deriveBchAddressesFromWif(
  wif: string,
  prefix: CashAddressNetworkPrefix = 'bchtest',
): BchAddressInfo {
  const trimmed = wif.trim();
  const decoded = decodePrivateKeyWif(trimmed);
  if (typeof decoded === 'string') {
    throw new Error(`Invalid BCH WIF key: ${decoded}`);
  }
  const pubKey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pubKey === 'string') {
    throw new Error(`Failed to derive public key: ${pubKey}`);
  }
  return deriveBchAddressesFromPubKey(pubKey, prefix);
}

/**
 * Derive checksummed EVM address from a private key hex string.
 */
export function deriveEvmAddress(privateKey: string): `0x${string}` {
  const trimmed = privateKey.trim();
  const formattedKey = (
    trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  ) as `0x${string}`;
  const account = privateKeyToAccount(formattedKey);
  return account.address;
}

/**
 * Generate a new Solana Keypair formatted as a base58 secretKey string.
 */
export function generateSolanaKeypair(): string {
  const kp = Keypair.generate();
  return bs58.encode(kp.secretKey);
}

/**
 * Validate a Solana keypair string (either base58-encoded 64 bytes or JSON array).
 */
export function isValidSolanaKeypair(key: string): boolean {
  const trimmed = key.trim();
  if (!trimmed) return false;
  try {
    if (trimmed.startsWith('[')) {
      const bytes = JSON.parse(trimmed);
      if (!Array.isArray(bytes) || bytes.length !== 64) return false;
      Keypair.fromSecretKey(Uint8Array.from(bytes));
      return true;
    }
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) return false;
    Keypair.fromSecretKey(decoded);
    return true;
  } catch {
    return false;
  }
}

/**
 * Derive Solana base58 public address from a keypair string (base58 or JSON array).
 */
export function deriveSolanaAddress(key: string): string {
  const trimmed = key.trim();
  let kp: Keypair;
  if (trimmed.startsWith('[')) {
    const bytes = JSON.parse(trimmed);
    kp = Keypair.fromSecretKey(Uint8Array.from(bytes));
  } else {
    const decoded = bs58.decode(trimmed);
    kp = Keypair.fromSecretKey(decoded);
  }
  return kp.publicKey.toBase58();
}
