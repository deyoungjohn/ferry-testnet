import { sha256, toBytes } from 'viem';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function createLinkId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(bytes, (byte) => BASE58[byte % BASE58.length]).join('');
}

export function createChallenge(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function payLinkMessage(
  challenge: string,
  lockingBytecode: string,
): string {
  return `ferry:paylink:v1:${challenge}:${lockingBytecode.toLowerCase()}`;
}

export function payLinksMessage(owner: string, challenge: string): string {
  return `ferry:paylinks:v1:${owner}:${challenge}`;
}

export function mockMessageSignature(message: string): string {
  return sha256(toBytes(message));
}

function normalizeSig(sig: string): string {
  const s = sig.toLowerCase().trim();
  return s.startsWith('0x') ? s : `0x${s}`;
}

export function verifyPayLinkSignature(
  challenge: string,
  signature: string,
  lockingBytecode: string,
  allowMock = false,
): boolean {
  if (!allowMock) {
    return false;
  }
  const expected = mockMessageSignature(
    payLinkMessage(challenge, lockingBytecode),
  );
  return normalizeSig(signature) === normalizeSig(expected);
}

export function verifyPayLinksSignature(
  owner: string,
  challenge: string,
  signature: string,
  allowMock = false,
): boolean {
  if (!allowMock) {
    return false;
  }
  const expected = mockMessageSignature(payLinksMessage(owner, challenge));
  return normalizeSig(signature) === normalizeSig(expected);
}
