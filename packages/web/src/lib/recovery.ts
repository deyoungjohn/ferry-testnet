import {
  ApiOrderTermsSchema,
  parseApiJson,
  serializeApiJson,
  type Hex32,
  type OrderTerms,
} from '@ferry/core';
import { deriveHtlcAddresses, encodeHtlcParameters } from '@ferry/htlc-bch';
import { z } from 'zod';
import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';
import { FERRY_HTLC_DEPLOYED_BYTECODE } from './contract-bytecode';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BCH_NETWORK,
  FERRY_HTLC_ADDRESS,
  FERRY_HTLC_CODE_HASH,
} from './config';

const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex32);

const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})*$/)
  .transform((value) => value.toLowerCase() as `0x${string}`);

export const RecoveryFileSchema = z.strictObject({
  version: z.literal(1),
  orderId: hex32,
  terms: ApiOrderTermsSchema,
  secret: hex32,
  createdAt: z.number().int().nonnegative(),
  contracts: z.strictObject({
    evm: z.strictObject({
      chainId: z.number().int().positive(),
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .transform((value) => value.toLowerCase()),
      codeHash: z.literal(FERRY_HTLC_CODE_HASH),
      bytecode: z
        .string()
        .refine(
          (value) => value === FERRY_HTLC_DEPLOYED_BYTECODE,
          'Unexpected FerryHTLC deployed bytecode',
        ),
      abi: z.array(z.unknown()),
    }),
    bch: z.strictObject({
      network: z.enum(['chipnet', 'mainnet']),
      htlcAddress: z.string().min(1),
      tokenAddress: z.string().min(1),
      redeemScript: hex,
      lockingBytecode: hex,
    }),
  }),
});

export type RecoveryFile = z.infer<typeof RecoveryFileSchema>;

export function bchParametersFromTerms(terms: OrderTerms) {
  return encodeHtlcParameters(terms);
}

export function buildRecoveryFile(
  orderId: Hex32,
  terms: OrderTerms,
  secret: Hex32,
  createdAt = Math.floor(Date.now() / 1000),
): RecoveryFile {
  const addresses = deriveHtlcAddresses(
    bchParametersFromTerms(terms),
    BCH_NETWORK,
  );

  return RecoveryFileSchema.parse({
    version: 1,
    orderId,
    terms,
    secret,
    createdAt,
    contracts: {
      evm: {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        address: FERRY_HTLC_ADDRESS,
        codeHash: FERRY_HTLC_CODE_HASH,
        bytecode: FERRY_HTLC_DEPLOYED_BYTECODE,
        abi: ferryHtlcAbi,
      },
      bch: {
        network: BCH_NETWORK,
        htlcAddress: addresses.p2sh32Address,
        tokenAddress: addresses.tokenAddress,
        redeemScript: `0x${Array.from(addresses.redeemScript, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
        lockingBytecode: `0x${Array.from(addresses.lockingBytecode, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      },
    },
  });
}

export function parseRecoveryFile(input: unknown): RecoveryFile {
  return RecoveryFileSchema.parse(input);
}

export function parseRecoveryFileJson(json: string): RecoveryFile {
  return parseApiJson(RecoveryFileSchema, json);
}

export function recoveryFileName(orderId: Hex32): string {
  return `ferry-${orderId}.json`;
}

export function downloadRecoveryFile(file: RecoveryFile): void {
  const blob = new Blob([serializeApiJson(file)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = recoveryFileName(file.orderId);
  anchor.rel = 'noopener';
  anchor.click();
  URL.revokeObjectURL(url);
}
