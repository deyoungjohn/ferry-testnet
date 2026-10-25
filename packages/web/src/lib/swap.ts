import {
  checkLimits,
  lockIntentTypedData,
  type Hex32,
  type OrderTerms,
} from '@ferry/core';
import {
  bytesToHex,
  formatUnits,
  parseUnits,
  sha256,
  type Address,
} from 'viem';
import {
  BASE_SEPOLIA_CHAIN_ID,
  FERRY_HTLC_ADDRESS,
  SOLVER_COUNTER_ADDRESS,
  MAX_SWAP_USD_MICROS,
  MIN_SWAP_USD_MICROS,
  PUSD_DECIMALS,
  USDC_ADDRESS,
  USDC_DECIMALS,
  USDC_DOMAIN,
} from './config';

export function parseUsdcAmount(input: string): bigint {
  const trimmed = input.trim();
  if (
    !/^\d*(?:\.\d{0,6})?$/.test(trimmed) ||
    trimmed === '' ||
    trimmed === '.'
  ) {
    throw new Error('Enter a USDC amount with at most 6 decimals');
  }
  const amount = parseUnits(trimmed, USDC_DECIMALS);
  if (amount <= 0n) throw new Error('Enter an amount above zero');
  if (
    !checkLimits(amount, USDC_DECIMALS, {
      minUsdMicros: MIN_SWAP_USD_MICROS,
      maxUsdMicros: MAX_SWAP_USD_MICROS,
    })
  ) {
    throw new Error('Swap amounts are $1 to $50');
  }
  return amount;
}

export function parsePusdAmount(input: string): bigint {
  const trimmed = input.trim();
  if (
    !/^\d*(?:\.\d{0,2})?$/.test(trimmed) ||
    trimmed === '' ||
    trimmed === '.'
  ) {
    throw new Error('Enter a tPUSD amount with at most 2 decimals');
  }
  const amount = parseUnits(trimmed, PUSD_DECIMALS);
  if (amount <= 0n) throw new Error('Enter an amount above zero');
  if (
    !checkLimits(amount, PUSD_DECIMALS, {
      minUsdMicros: MIN_SWAP_USD_MICROS,
      maxUsdMicros: MAX_SWAP_USD_MICROS,
    })
  ) {
    throw new Error('Swap amounts are $1 to $50');
  }
  return amount;
}

export function generateSecret(): Hex32 {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes) as Hex32;
}

export function hashLockForSecret(secret: Hex32): Hex32 {
  return sha256(secret) as Hex32;
}

export function formatUsdc(amount: bigint): string {
  return formatUnits(amount, USDC_DECIMALS);
}

export function formatPusd(amount: bigint): string {
  return formatUnits(amount, 2);
}

export function quoteRate(terms: OrderTerms): string {
  const input =
    terms.direction === 'COUNTER_TO_BCH'
      ? Number(terms.counterAmount) / 10 ** USDC_DECIMALS
      : Number(terms.bchTokenAmount) / 10 ** PUSD_DECIMALS;
  const output =
    terms.direction === 'COUNTER_TO_BCH'
      ? Number(terms.bchTokenAmount) / 10 ** PUSD_DECIMALS
      : Number(terms.counterAmount) / 10 ** USDC_DECIMALS;
  return (output / input).toFixed(4);
}

export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function buildPermitTypedData(
  terms: OrderTerms,
  owner: Address,
  nonce: bigint,
) {
  return {
    domain: USDC_DOMAIN,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: {
      owner,
      spender: FERRY_HTLC_ADDRESS,
      value: terms.counterAmount,
      nonce,
      deadline: BigInt(terms.quoteExpiry),
    },
  } as const;
}

export function buildIntentTypedData(terms: OrderTerms) {
  return lockIntentTypedData(
    {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: FERRY_HTLC_ADDRESS,
    },
    {
      token: USDC_ADDRESS,
      recipient: SOLVER_COUNTER_ADDRESS,
      amount: terms.counterAmount,
      hashLock: terms.hashLock,
      deadline: BigInt(terms.counterDeadline),
      intentDeadline: BigInt(terms.quoteExpiry),
    },
  );
}

export function truncateAddress(address: string, left = 6, right = 4): string {
  if (address.length <= left + right + 1) return address;
  return `${address.slice(0, left)}…${address.slice(-right)}`;
}
