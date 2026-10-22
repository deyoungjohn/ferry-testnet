import { z } from 'zod';
import { bytesToHex, hexToBytes, sha256 } from 'viem';

export type Hex = `0x${string}`;
export type Hex32 = Hex;
export const COUNTER_CHAINS = [
  'base',
  'arbitrum',
  'ethereum',
  'arc',
  'solana',
  'tron',
  'bsc',
] as const;
export type CounterChain = (typeof COUNTER_CHAINS)[number];
export type Direction = 'COUNTER_TO_BCH' | 'BCH_TO_COUNTER';
const wellFormed = (value: string) =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
    value,
  );
const text = z.string().min(1).max(256).refine(wellFormed, 'Invalid Unicode');
const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .max(20002)
  .transform((value) => value.toLowerCase() as Hex);
const hex32 = hex.refine(
  (value) => value.length === 66,
  'Expected exactly 32 bytes',
);
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z
  .bigint()
  .positive()
  .max((1n << 256n) - 1n);
const evmAddress = /^0x[0-9a-fA-F]{40}$/;

/** Strict wire-independent terms: monetary amounts are bigint base units, never floats. */
export const OrderTermsSchema = z
  .strictObject({
    version: z.literal(1),
    direction: z.enum(['COUNTER_TO_BCH', 'BCH_TO_COUNTER']),
    bchToken: z.enum(['PUSD', 'MUSD']),
    bchTokenCategory: hex32,
    bchTokenAmount: amount,
    counterAmount: amount,
    counterChain: z.enum(COUNTER_CHAINS),
    counterNetworkId: z.union([uint.positive(), text]),
    counterAsset: z.strictObject({
      symbol: z.enum(['USDC', 'USDT']),
      decimals: uint.max(36),
      address: text,
    }),
    counterHtlc: text,
    userCounterAddress: text,
    solverCounterAddress: text,
    userBchLockingBytecode: hex,
    solverBchLockingBytecode: hex,
    hashLock: hex32,
    counterDeadline: uint.positive(),
    bchRefundHeight: uint.positive().max(499999999),
    bchCarrySats: amount.max((1n << 64n) - 1n),
    bchMaxFee: z.bigint().nonnegative(),
    quoteId: text,
    quoteExpiry: uint.positive(),
  })
  .superRefine((terms, ctx) => {
    if (terms.bchMaxFee > terms.bchCarrySats)
      ctx.addIssue({
        code: 'custom',
        message: 'Fee exceeds carry',
        path: ['bchMaxFee'],
      });
    const evm =
      terms.counterChain !== 'solana' && terms.counterChain !== 'tron';
    if (evm !== (typeof terms.counterNetworkId === 'number'))
      ctx.addIssue({
        code: 'custom',
        message: 'EVM network IDs must be numeric; other networks use labels',
        path: ['counterNetworkId'],
      });
    const addressPattern = evm
      ? evmAddress
      : terms.counterChain === 'tron'
        ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/
        : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    for (const [field, value] of [
      ['counterHtlc', terms.counterHtlc],
      ['userCounterAddress', terms.userCounterAddress],
      ['solverCounterAddress', terms.solverCounterAddress],
      ['counterAsset.address', terms.counterAsset.address],
    ]) {
      if (!addressPattern.test(value!))
        ctx.addIssue({
          code: 'custom',
          message: 'Malformed chain address',
          path: field!.split('.'),
        });
    }
  })
  .transform((terms) => {
    if (terms.counterChain === 'solana' || terms.counterChain === 'tron')
      return terms;
    return {
      ...terms,
      counterHtlc: terms.counterHtlc.toLowerCase(),
      userCounterAddress: terms.userCounterAddress.toLowerCase(),
      solverCounterAddress: terms.solverCounterAddress.toLowerCase(),
      counterAsset: {
        ...terms.counterAsset,
        address: terms.counterAsset.address.toLowerCase(),
      },
    };
  });
export type OrderTerms = z.infer<typeof OrderTermsSchema>;
export function parseOrderTerms(input: unknown): OrderTerms {
  return OrderTermsSchema.parse(input);
}

type Value = string | number | bigint | Uint8Array | { [key: string]: Value };
function join(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function head(major: number, value: bigint): Uint8Array {
  if (value < 24n) return Uint8Array.of((major << 5) | Number(value));
  const width =
    value <= 255n ? 1 : value <= 65535n ? 2 : value <= 4294967295n ? 4 : 8;
  const result = new Uint8Array(width + 1);
  result[0] = (major << 5) | { 1: 24, 2: 25, 4: 26, 8: 27 }[width]!;
  for (let i = width; i > 0; i--) {
    result[i] = Number(value & 255n);
    value >>= 8n;
  }
  return result;
}
function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}
function encode(value: Value): Uint8Array {
  if (typeof value === 'number') return head(0, BigInt(value));
  if (typeof value === 'bigint') {
    if (value < 1n << 64n) return head(0, value);
    let hex = value.toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return join([Uint8Array.of(0xc2), encode(hexToBytes(`0x${hex}`))]);
  }
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return join([head(3, BigInt(bytes.length)), bytes]);
  }
  if (value instanceof Uint8Array)
    return join([head(2, BigInt(value.length)), value]);
  const entries = Object.entries(value)
    .map(([key, child]) => ({ key: encode(key), child: encode(child) }))
    .sort((a, b) => compare(a.key, b.key));
  return join([
    head(5, BigInt(entries.length)),
    ...entries.flatMap((entry) => [entry.key, entry.child]),
  ]);
}
/** RFC 8949 §4.2.1: definite lengths, shortest uints/tag-2 bignums, bytewise map keys.
 * Hash/category/BCH script fields are byte strings. Addresses, symbols and IDs are
 * UTF-8 text (EVM addresses lowercase; base58 case preserved). No Unicode normalization.
 */
export function canonicalCBOR(input: unknown): Uint8Array {
  const terms = parseOrderTerms(input);
  return encode({
    ...terms,
    hashLock: hexToBytes(terms.hashLock),
    bchTokenCategory: hexToBytes(terms.bchTokenCategory),
    userBchLockingBytecode: hexToBytes(terms.userBchLockingBytecode),
    solverBchLockingBytecode: hexToBytes(terms.solverBchLockingBytecode),
  });
}
export function orderId(input: unknown): Hex32 {
  return sha256(bytesToHex(canonicalCBOR(input)));
}
