import { sha256, toBytes } from 'viem';

export const MOCK_PAY_LINK_ID = 'MockPayLink111111111';
export const MOCK_RESERVED_LINK_ID = 'MockReservedLink1111';
export const MOCK_EXPIRED_LINK_ID = 'MockExpiredLink111111';

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

export function verifyPayLinkSignature(
  challenge: string,
  signature: string,
  lockingBytecode: string,
): boolean {
  return (
    signature ===
    mockMessageSignature(payLinkMessage(challenge, lockingBytecode))
  );
}

export function verifyPayLinksSignature(
  owner: string,
  challenge: string,
  signature: string,
): boolean {
  return signature === mockMessageSignature(payLinksMessage(owner, challenge));
}

export function chunkCashaddr(address: string): string {
  const separator = address.indexOf(':');
  if (separator < 0) return address.match(/.{1,4}/g)?.join(' ') ?? address;
  const prefix = address.slice(0, separator + 1);
  const body = address.slice(separator + 1);
  return `${prefix}${body.match(/.{1,4}/g)?.join(' ') ?? body}`;
}

export function payLinkUrl(id: string): string {
  const origin =
    typeof window !== 'undefined' && window.location.origin
      ? window.location.origin
      : '';
  return `${origin}/p/${id}`;
}
