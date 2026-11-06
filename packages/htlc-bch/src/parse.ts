import {
  authenticationInstructionsAreMalformed,
  decodeAuthenticationInstructions,
  decodeTransactionBCH,
  hexToBin,
  sha256,
  vmNumberToBigInt,
  type AuthenticationInstruction,
  type Transaction,
} from '@bitauth/libauth';
import { deriveHtlcAddresses, getHtlcContract } from './contract.js';
import type { BchHtlcParameters, CashAddressNetwork } from './types.js';

export type { Transaction };
export { decodeTransactionBCH };

const OP_0 = 0x00;
const OP_1 = 0x51;
const OP_16 = 0x60;
const OP_1NEGATE = 0x4f;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function pushValue(instruction: AuthenticationInstruction): Uint8Array | null {
  if ('data' in instruction) return instruction.data;
  if (instruction.opcode === OP_0) return new Uint8Array();
  if (instruction.opcode >= OP_1 && instruction.opcode <= OP_16) {
    return Uint8Array.of(instruction.opcode - OP_1 + 1);
  }
  if (instruction.opcode === OP_1NEGATE) return Uint8Array.of(0x81);
  return null;
}

/** Leading pushes of a script, as raw values (OP_1..OP_16 become their number). */
function leadingPushes(script: Uint8Array): Uint8Array[] {
  const parsed = decodeAuthenticationInstructions(script);
  if (authenticationInstructionsAreMalformed(parsed)) return [];
  const out: Uint8Array[] = [];
  for (const instruction of parsed) {
    const value = pushValue(instruction);
    if (value === null) break;
    out.push(value);
  }
  return out;
}

function toNumber(bytes: Uint8Array): bigint | null {
  const value = vmNumberToBigInt(bytes, { requireMinimalEncoding: false });
  return typeof value === 'bigint' ? value : null;
}

/**
 * Read the constructor parameters back out of a FerryHTLC redeem script.
 * CashScript pushes the constructor arguments in reverse order before the
 * contract code. The result is only returned when rebuilding the contract from
 * the parameters gives the exact same script, so a foreign script never passes.
 */
export function parseHtlcRedeemScript(
  redeemScript: Uint8Array,
): BchHtlcParameters | null {
  const pushes = leadingPushes(redeemScript);
  if (pushes.length < 7) return null;
  const [
    maxFee,
    refundHeight,
    tokenAmount,
    tokenCategory,
    refundBytecode,
    recipientBytecode,
    hashLock,
  ] = pushes as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const fee = toNumber(maxFee);
  const height = toNumber(refundHeight);
  const amount = toNumber(tokenAmount);
  if (fee === null || height === null || amount === null) return null;
  if (hashLock.length !== 32 || tokenCategory.length !== 32) return null;
  if (height < 0n || height >= 500_000_000n || amount <= 0n) return null;
  const params: BchHtlcParameters = {
    hashLock,
    recipientLockingBytecode: recipientBytecode,
    refundLockingBytecode: refundBytecode,
    tokenCategory,
    tokenAmount: amount,
    refundHeight: Number(height),
    maxFee: fee,
  };
  try {
    const rebuilt = hexToBin(getHtlcContract(params).bytecode);
    return sameBytes(rebuilt, redeemScript) ? params : null;
  } catch {
    return null;
  }
}

export interface HtlcSpendInfo {
  readonly params: BchHtlcParameters;
  readonly path: 'claim' | 'refund';
  /** Present for a claim: the revealed secret (its sha256 equals the hash lock). */
  readonly secret: Uint8Array | null;
  readonly lockingBytecode: Uint8Array;
}

/** If an input's unlocking script spends a FerryHTLC, say how and with what parameters. */
export function parseHtlcSpendInput(
  unlockingBytecode: Uint8Array,
): HtlcSpendInfo | null {
  const parsed = decodeAuthenticationInstructions(unlockingBytecode);
  if (authenticationInstructionsAreMalformed(parsed) || parsed.length === 0) {
    return null;
  }
  const last = parsed[parsed.length - 1];
  if (!last || !('data' in last)) return null;
  const params = parseHtlcRedeemScript(last.data);
  if (!params) return null;
  const secret =
    parsed
      .slice(0, -1)
      .map((instruction) => ('data' in instruction ? instruction.data : null))
      .find(
        (data): data is Uint8Array =>
          data !== null &&
          data.length === 32 &&
          sameBytes(sha256.hash(data), params.hashLock),
      ) ?? null;
  return {
    params,
    path: secret ? 'claim' : 'refund',
    secret,
    lockingBytecode: deriveHtlcAddresses(params).lockingBytecode,
  };
}

export function covenantNetworkPrefix(network: CashAddressNetwork): string {
  return network === 'mainnet' ? 'bitcoincash' : 'bchtest';
}
