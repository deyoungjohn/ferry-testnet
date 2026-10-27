import {
  TransactionBuilder,
  MockNetworkProvider,
  type NetworkProvider,
  Network,
} from 'cashscript';
import {
  binToHex,
  hexToBin,
  sha256,
  createVirtualMachineBCH,
  decodeTransaction,
} from '@bitauth/libauth';
import type { BchHtlcParameters, CashAddressNetwork } from './types.js';
import { getHtlcContract } from './contract.js';
import { internalToDisplayCategory } from './byte-order.js';

interface TransactionBuilderWithLibauth {
  buildLibauthTransaction(): unknown;
}

function computeTxId(txHex: string): string {
  const raw = hexToBin(txHex);
  const hash = sha256.hash(sha256.hash(raw));
  const reversed = new Uint8Array(hash.length);
  for (let i = 0; i < hash.length; i++) {
    reversed[i] = hash[hash.length - 1 - i]!;
  }
  return binToHex(reversed);
}

export interface HtlcUtxo {
  txid: string;
  vout: number;
  satoshis: bigint | number;
  lockingBytecode?: string;
}

export interface BuildClaimTxOptions {
  params: BchHtlcParameters;
  utxo: HtlcUtxo;
  secret: Uint8Array | string;
  feeSats?: bigint | number; // Default 500n
  network?: CashAddressNetwork;
  provider?: NetworkProvider;
  overrideDisplayCategory?: string;
  skipVmVerify?: boolean;
}

export interface BuildRefundTxOptions {
  params: BchHtlcParameters;
  utxo: HtlcUtxo;
  feeSats?: bigint | number; // Default 500n
  network?: CashAddressNetwork;
  provider?: NetworkProvider;
  overrideDisplayCategory?: string;
  skipVmVerify?: boolean;
}

/**
 * Verify a built Libauth transaction and its source outputs against consensus script rules.
 * Returns true on success or a descriptive error string on failure.
 */
export function verifyBchTransactionWithVm(params: {
  transaction: unknown;
  sourceOutputs: unknown[];
}): true | string {
  let tx = params.transaction;
  if (typeof tx === 'string') {
    const decoded = decodeTransaction(hexToBin(tx));
    if (typeof decoded === 'string') {
      return `Failed to decode transaction hex: ${decoded}`;
    }
    tx = decoded;
  }
  const vm = createVirtualMachineBCH();
  type VerifyParams = Parameters<typeof vm.verify>[0];
  return vm.verify({
    transaction: tx as VerifyParams['transaction'],
    sourceOutputs: params.sourceOutputs as VerifyParams['sourceOutputs'],
  });
}

/**
 * Verify a claim transaction hex against HTLC parameters and the source UTXO.
 */
export function verifyClaimTransactionHex(options: {
  params: BchHtlcParameters;
  utxo: HtlcUtxo;
  txHex: string;
  network?: CashAddressNetwork;
  overrideDisplayCategory?: string;
}): true | string {
  const contract = getHtlcContract(options.params, {
    ...(options.network !== undefined ? { network: options.network } : {}),
  });
  const displayCategory =
    options.overrideDisplayCategory ??
    internalToDisplayCategory(options.params.tokenCategory);
  const utxoSatoshis = BigInt(options.utxo.satoshis);
  const sourceOutput = {
    lockingBytecode: hexToBin(contract.lockingBytecode),
    valueSatoshis: utxoSatoshis,
    token: {
      category: hexToBin(displayCategory),
      amount: options.params.tokenAmount,
    },
  };
  return verifyBchTransactionWithVm({
    transaction: options.txHex,
    sourceOutputs: [sourceOutput],
  });
}

/**
 * Verify a refund transaction hex against HTLC parameters and the source UTXO.
 */
export function verifyRefundTransactionHex(options: {
  params: BchHtlcParameters;
  utxo: HtlcUtxo;
  txHex: string;
  network?: CashAddressNetwork;
  overrideDisplayCategory?: string;
}): true | string {
  const contract = getHtlcContract(options.params, {
    ...(options.network !== undefined ? { network: options.network } : {}),
  });
  const displayCategory =
    options.overrideDisplayCategory ??
    internalToDisplayCategory(options.params.tokenCategory);
  const utxoSatoshis = BigInt(options.utxo.satoshis);
  const sourceOutput = {
    lockingBytecode: hexToBin(contract.lockingBytecode),
    valueSatoshis: utxoSatoshis,
    token: {
      category: hexToBin(displayCategory),
      amount: options.params.tokenAmount,
    },
  };
  return verifyBchTransactionWithVm({
    transaction: options.txHex,
    sourceOutputs: [sourceOutput],
  });
}

export interface BuiltTransaction {
  txHex: string;
  txid: string;
  libauthTx: unknown;
  sourceOutput: {
    lockingBytecode: Uint8Array;
    valueSatoshis: bigint;
    token: {
      category: Uint8Array;
      amount: bigint;
    };
  };
  builder: TransactionBuilder;
}

/**
 * Build a valid spend transaction for FerryHTLC.claim(secret).
 */
export function buildClaimTransaction(
  options: BuildClaimTxOptions,
): BuiltTransaction {
  let provider = options.provider;
  if (!provider) {
    const mock = new MockNetworkProvider();
    mock.network =
      options.network === 'mainnet' ? Network.MAINNET : Network.CHIPNET;
    provider = mock;
  }

  const contract = getHtlcContract(options.params, {
    provider,
    ...(options.network !== undefined ? { network: options.network } : {}),
  });
  const fee = BigInt(options.feeSats ?? 500n);
  if (fee > options.params.maxFee) {
    throw new Error(`Fee ${fee} exceeds maxFee ${options.params.maxFee}`);
  }

  const utxoSatoshis = BigInt(options.utxo.satoshis);
  if (utxoSatoshis < fee) {
    throw new Error(
      `UTXO satoshis ${utxoSatoshis} insufficient for fee ${fee}`,
    );
  }

  const outputAmount = utxoSatoshis - fee;

  const secretBytes =
    typeof options.secret === 'string'
      ? hexToBin(
          options.secret.startsWith('0x')
            ? options.secret.slice(2)
            : options.secret,
        )
      : options.secret;

  const displayCategory =
    options.overrideDisplayCategory ??
    internalToDisplayCategory(options.params.tokenCategory);

  const utxo = {
    txid: options.utxo.txid,
    vout: options.utxo.vout,
    satoshis: utxoSatoshis,
    lockingBytecode: options.utxo.lockingBytecode ?? contract.lockingBytecode,
    token: {
      category: displayCategory,
      amount: options.params.tokenAmount,
    },
  };

  const builder = new TransactionBuilder({ provider });
  builder.addInput(utxo, contract.unlock.claim(secretBytes));
  builder.addOutput({
    to: options.params.recipientLockingBytecode,
    amount: outputAmount,
    token: {
      category: displayCategory,
      amount: options.params.tokenAmount,
    },
  });

  const txHex = builder.build();
  const libauthTx = (
    builder as unknown as TransactionBuilderWithLibauth
  ).buildLibauthTransaction();
  const txid = computeTxId(txHex);

  const sourceOutput = {
    lockingBytecode: hexToBin(contract.lockingBytecode),
    valueSatoshis: utxoSatoshis,
    token: {
      category: hexToBin(displayCategory),
      amount: options.params.tokenAmount,
    },
  };

  if (!options.skipVmVerify) {
    const vmResult = verifyBchTransactionWithVm({
      transaction: libauthTx,
      sourceOutputs: [sourceOutput],
    });
    if (vmResult !== true) {
      throw new Error(`BCH claim script VM verification failed: ${vmResult}`);
    }
  }

  return {
    txHex,
    txid,
    libauthTx,
    sourceOutput,
    builder,
  };
}

/**
 * Build a valid spend transaction for FerryHTLC.refund().
 * Sets locktime = refundHeight and input sequence = 0xfffffffe (non-final).
 */
export function buildRefundTransaction(
  options: BuildRefundTxOptions,
): BuiltTransaction {
  let provider = options.provider;
  if (!provider) {
    const mock = new MockNetworkProvider();
    mock.network =
      options.network === 'mainnet' ? Network.MAINNET : Network.CHIPNET;
    provider = mock;
  }

  const contract = getHtlcContract(options.params, {
    provider,
    ...(options.network !== undefined ? { network: options.network } : {}),
  });
  const fee = BigInt(options.feeSats ?? 500n);
  if (fee > options.params.maxFee) {
    throw new Error(`Fee ${fee} exceeds maxFee ${options.params.maxFee}`);
  }

  const utxoSatoshis = BigInt(options.utxo.satoshis);
  if (utxoSatoshis < fee) {
    throw new Error(
      `UTXO satoshis ${utxoSatoshis} insufficient for fee ${fee}`,
    );
  }

  const outputAmount = utxoSatoshis - fee;

  const displayCategory =
    options.overrideDisplayCategory ??
    internalToDisplayCategory(options.params.tokenCategory);

  const utxo = {
    txid: options.utxo.txid,
    vout: options.utxo.vout,
    satoshis: utxoSatoshis,
    lockingBytecode: options.utxo.lockingBytecode ?? contract.lockingBytecode,
    token: {
      category: displayCategory,
      amount: options.params.tokenAmount,
    },
  };

  const builder = new TransactionBuilder({ provider });
  // Set sequence to 0xfffffffe so locktime is enforced by consensus
  builder.addInput(utxo, contract.unlock.refund(), { sequence: 0xfffffffe });
  builder.setLocktime(options.params.refundHeight);
  builder.addOutput({
    to: options.params.refundLockingBytecode,
    amount: outputAmount,
    token: {
      category: displayCategory,
      amount: options.params.tokenAmount,
    },
  });

  const txHex = builder.build();
  const libauthTx = (
    builder as unknown as TransactionBuilderWithLibauth
  ).buildLibauthTransaction();
  const txid = computeTxId(txHex);

  const sourceOutput = {
    lockingBytecode: hexToBin(contract.lockingBytecode),
    valueSatoshis: utxoSatoshis,
    token: {
      category: hexToBin(displayCategory),
      amount: options.params.tokenAmount,
    },
  };

  if (!options.skipVmVerify) {
    const vmResult = verifyBchTransactionWithVm({
      transaction: libauthTx,
      sourceOutputs: [sourceOutput],
    });
    if (vmResult !== true) {
      throw new Error(`BCH refund script VM verification failed: ${vmResult}`);
    }
  }

  return {
    txHex,
    txid,
    libauthTx,
    sourceOutput,
    builder,
  };
}
