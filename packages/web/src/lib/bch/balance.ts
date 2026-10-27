import { formatUnits } from 'viem';
import type { BchUtxo } from '../wallet/types';

export interface WalletBalance {
  readonly tokenAmount: bigint;
  readonly satoshis: bigint;
}

export function summarizeBalance(
  utxos: readonly BchUtxo[],
  category: string,
): WalletBalance {
  const wanted = category.toLowerCase().replace(/^0x/, '');
  let tokenAmount = 0n;
  let satoshis = 0n;
  for (const utxo of utxos) {
    satoshis += utxo.satoshis;
    if (utxo.token?.category.toLowerCase().replace(/^0x/, '') === wanted) {
      tokenAmount += utxo.token.amount;
    }
  }
  return { tokenAmount, satoshis };
}

export function formatBch(satoshis: bigint): string {
  const text = formatUnits(satoshis, 8);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function formatToken(amount: bigint, decimals: number): string {
  const text = formatUnits(amount, decimals);
  const [whole = '0', fraction = ''] = text.split('.');
  return decimals === 0 ? whole : `${whole}.${fraction.padEnd(decimals, '0')}`;
}

/** Say what is missing in units a person reads. */
export function describeShortfall(
  balance: WalletBalance,
  required: { tokenAmount: bigint; carrySats: bigint; symbol: string },
  decimals = 2,
): string | null {
  if (balance.tokenAmount < required.tokenAmount) {
    return `You need ${formatToken(required.tokenAmount, decimals)} ${required.symbol} but this wallet has ${formatToken(balance.tokenAmount, decimals)} ${required.symbol}.`;
  }
  if (balance.satoshis < required.carrySats + 1_000n) {
    return `You also need a little BCH for the lock and network fee (at least ${formatBch(required.carrySats + 1_000n)} BCH); this wallet has ${formatBch(balance.satoshis)} BCH.`;
  }
  return null;
}

/** Turn the lock builder's raw "required 500, available 188" into readable text. */
export function friendlyBuildError(
  message: string,
  symbol: string,
  decimals = 2,
): string {
  const match = /required (\d+), available (\d+)/i.exec(message);
  if (/insufficient token/i.test(message) && match) {
    return `You need ${formatToken(BigInt(match[1] ?? '0'), decimals)} ${symbol} but this wallet has ${formatToken(BigInt(match[2] ?? '0'), decimals)} ${symbol}.`;
  }
  if (/insufficient/i.test(message)) {
    return 'This wallet does not have enough BCH for the lock and the network fee.';
  }
  return message;
}
