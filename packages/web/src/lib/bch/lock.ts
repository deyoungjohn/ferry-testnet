import type { OrderTerms } from '@ferry/core';
import { buildLockTransaction, deriveHtlcAddresses } from '@ferry/htlc-bch';
import { BCH_NETWORK } from '../config';
import { bchParametersFromTerms } from '../recovery';
import type { BchSignTransactionRequest, BchUtxo } from '../wallet/types';

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

export function buildReverseLock(
  options: BuildReverseLockOptions,
): ReverseLockBuild {
  const target = reverseFundingTarget(options.terms, options.network);
  if (options.utxos.length === 0) {
    throw new Error('No BCH token UTXOs available for funding');
  }
  const built = buildLockTransaction({
    params: options.terms,
    utxos: options.utxos.map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingBytecode: utxo.lockingBytecode,
      ...(utxo.token
        ? {
            token: {
              category: utxo.token.category.toLowerCase().replace(/^0x/, ''),
              amount: utxo.token.amount,
            },
          }
        : {}),
    })),
    changeAddress: options.changeAddress,
    bchCarrySats: options.bchCarrySats ?? options.terms.bchCarrySats,
    network: options.network ?? BCH_NETWORK,
    userPrompt:
      options.userPrompt ??
      `Lock ${options.terms.bchTokenAmount.toString()} tPUSD into Ferry HTLC`,
  });
  return {
    txHex: built.unsigned.txHex,
    txid: built.unsigned.txid,
    wcSignRequest: {
      transaction: built.unsigned.txHex,
      sourceOutputs: built.unsigned.sourceOutputs,
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
