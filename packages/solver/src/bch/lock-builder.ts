import * as libauth from '@bitauth/libauth';

export function computeTxId(txHex: string): string {
  const raw = libauth.hexToBin(txHex);
  const hash = libauth.sha256.hash(libauth.sha256.hash(raw));
  const reversed = new Uint8Array(hash.length);
  for (let i = 0; i < hash.length; i++) {
    reversed[i] = hash[hash.length - 1 - i]!;
  }
  return libauth.binToHex(reversed);
}

export async function deriveBchKeyDetails(
  wif: string,
  prefix: 'bchtest' | 'bitcoincash' = 'bchtest',
) {
  const decoded = libauth.decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') {
    throw new Error(`Failed to decode WIF: ${decoded}`);
  }
  const secp = await libauth.instantiateSecp256k1();
  const pub = secp.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') {
    throw new Error('Failed to derive public key');
  }
  const pkh = libauth.hash160(pub);
  const p2pkhBytecode = new Uint8Array([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
  const p2pkhBytecodeHex = libauth.binToHex(p2pkhBytecode);
  const scriptHash = libauth.binToHex(
    libauth.sha256.hash(p2pkhBytecode).reverse(),
  );

  const cashAddressResult = libauth.lockingBytecodeToCashAddress({
    bytecode: p2pkhBytecode,
    prefix,
  });
  const address =
    typeof cashAddressResult === 'string'
      ? undefined
      : cashAddressResult.address;

  return {
    privateKey: decoded.privateKey,
    p2pkhBytecode,
    p2pkhBytecodeHex,
    lockingBytecodeHex: p2pkhBytecodeHex,
    scriptHash,
    address,
  };
}

export function extractSecretFromClaimUnlock(
  unlockingBytecode: Uint8Array,
  expectedHashLock: string,
): `0x${string}` | null {
  const cleanExpected = expectedHashLock.startsWith('0x')
    ? expectedHashLock.slice(2).toLowerCase()
    : expectedHashLock.toLowerCase();

  // 1. Direct check: standard CashScript push (0x20 = 32 bytes)
  if (unlockingBytecode.length >= 33 && unlockingBytecode[0] === 0x20) {
    const candidate = unlockingBytecode.slice(1, 33);
    const hash = libauth.binToHex(libauth.sha256.hash(candidate));
    if (hash === cleanExpected) {
      return `0x${libauth.binToHex(candidate)}`;
    }
  }

  // 2. Sliding window check
  for (let i = 0; i <= unlockingBytecode.length - 32; i++) {
    const candidate = unlockingBytecode.slice(i, i + 32);
    const hash = libauth.binToHex(libauth.sha256.hash(candidate));
    if (hash === cleanExpected) {
      return `0x${libauth.binToHex(candidate)}`;
    }
  }

  return null;
}
