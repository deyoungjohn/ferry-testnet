import { hexToBin } from '@bitauth/libauth';
import type { OrderTerms } from '@ferry/core';
import { deriveHtlcAddresses } from '@ferry/htlc-bch';
import { BCH_NETWORK } from '../config';
import { bchParametersFromTerms } from '../recovery';
import type {
  BchSignTransactionRequest,
  BchSourceOutput,
  BchUtxo,
} from '../wallet/types';

export interface ReverseFundingTarget {
  readonly htlcP2sh32Address: string;
  readonly htlcTokenAddress: string;
  readonly tokenAmount: bigint;
  readonly tokenCategory: string;
  readonly lockingBytecode: `0x${string}`;
}

export interface BuildReverseLockOptions {
  readonly terms: OrderTerms;
  readonly utxos: readonly BchUtxo[];
  readonly changeAddress: string;
  readonly bchCarrySats?: bigint;
  readonly network?: 'chipnet' | 'mainnet';
  readonly userPrompt?: string;
}

export interface ReverseLockBuild {
  readonly txHex: string;
  readonly txid: string;
  readonly wcSignRequest: BchSignTransactionRequest;
  readonly htlcP2sh32Address: string;
  readonly htlcTokenAddress: string;
  readonly tokenAmount: bigint;
}

export function assertReverseFundingTarget(
  terms: OrderTerms,
  userLockingBytecode: string,
  solverLockingBytecode: string,
  network: 'chipnet' | 'mainnet' = BCH_NETWORK,
): ReverseFundingTarget {
  if (terms.direction !== 'BCH_TO_COUNTER') {
    throw new Error('Reverse funding requires a BCH_TO_COUNTER quote');
  }
  if (
    terms.userBchLockingBytecode.toLowerCase() !==
    userLockingBytecode.toLowerCase()
  ) {
    throw new Error('Quote BCH refund address does not match this wallet');
  }
  if (
    terms.solverBchLockingBytecode.toLowerCase() !==
    solverLockingBytecode.toLowerCase()
  ) {
    throw new Error(
      'Quote solver BCH address does not match the pinned solver',
    );
  }
  return reverseFundingTarget(terms, network);
}

export function reverseFundingTarget(
  terms: OrderTerms,
  network: 'chipnet' | 'mainnet' = BCH_NETWORK,
): ReverseFundingTarget {
  if (terms.direction !== 'BCH_TO_COUNTER') {
    throw new Error('Reverse funding requires a BCH_TO_COUNTER quote');
  }
  const addresses = deriveHtlcAddresses(bchParametersFromTerms(terms), network);
  return {
    htlcP2sh32Address: addresses.p2sh32Address,
    htlcTokenAddress: addresses.tokenAddress,
    tokenAmount: terms.bchTokenAmount,
    tokenCategory: terms.bchTokenCategory,
    lockingBytecode: `0x${Array.from(addresses.lockingBytecode, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')}`,
  };
}

function sourceOutput(utxo: BchUtxo): BchSourceOutput {
  return {
    outpointIndex: utxo.vout,
    outpointTransactionHash: hexToBin(utxo.txid),
    sequenceNumber: 0,
    unlockingBytecode: new Uint8Array(0),
    valueSatoshis: utxo.satoshis,
    lockingBytecode: hexToBin(utxo.lockingBytecode.slice(2)),
    ...(utxo.token
      ? {
          token: {
            category: hexToBin(utxo.token.category.slice(2)),
            amount: utxo.token.amount,
          },
        }
      : {}),
  };
}

export function buildMockReverseLock(
  options: BuildReverseLockOptions,
): ReverseLockBuild {
  const target = reverseFundingTarget(options.terms, options.network);
  if (options.utxos.length === 0) {
    throw new Error('No BCH token UTXOs available for funding');
  }
  const category = (value: string): string =>
    value.toLowerCase().replace(/^0x/, '');
  const tokenCategory = category(options.terms.bchTokenCategory);
  const total = options.utxos.reduce(
    (sum, utxo) =>
      utxo.token && category(utxo.token.category) === tokenCategory
        ? sum + utxo.token.amount
        : sum,
    0n,
  );
  if (total < options.terms.bchTokenAmount) {
    throw new Error(
      `Insufficient tPUSD: required ${options.terms.bchTokenAmount.toString()}, available ${total.toString()}`,
    );
  }
  const txHex = '0200000000';
  return {
    txHex,
    txid: 'ab'.repeat(32),
    wcSignRequest: {
      transaction: txHex,
      sourceOutputs: options.utxos.map(sourceOutput),
      broadcast: false,
      userPrompt:
        options.userPrompt ??
        `Lock ${options.terms.bchTokenAmount.toString()} tPUSD into Ferry HTLC`,
    },
    htlcP2sh32Address: target.htlcP2sh32Address,
    htlcTokenAddress: target.htlcTokenAddress,
    tokenAmount: options.terms.bchTokenAmount,
  };
}

export function buildReverseLock(
  options: BuildReverseLockOptions,
): ReverseLockBuild {
  void options;
  throw new Error(
    'The BCH lock builder is not available in this build yet; use the QR/manual funding path',
  );
}
