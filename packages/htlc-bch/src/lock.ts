import {
  TransactionBuilder,
  MockNetworkProvider,
  SignatureTemplate,
  type NetworkProvider,
  Network,
} from 'cashscript';
import {
  binToHex,
  hexToBin,
  sha256,
  encodeTransaction,
  decodeTransaction,
  type Transaction,
  type Output,
} from '@bitauth/libauth';
import type {
  BchHtlcParameters,
  HtlcInputTerms,
  OrderTerms,
  CashAddressNetwork,
} from './types.js';
import type { ElectrumUtxo } from './electrum.js';
import {
  deriveHtlcAddresses,
  encodeHtlcParameters,
  resolveLockingBytecode,
} from './contract.js';
import { internalToDisplayCategory } from './byte-order.js';
import { verifyBchTransactionWithVm } from './spends.js';

export interface LockUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  lockingBytecode?: Uint8Array | undefined;
  token?:
    | {
        category: string; // 32-byte display hex
        amount: bigint;
        nft?:
          | {
              capability?: string | undefined;
              commitment?: string | Uint8Array | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface WcContractInfo {
  abiFunction: {
    name: string;
    inputs: readonly { name: string; type: string }[];
  };
  redeemScript: Uint8Array;
  artifact: unknown;
}

/**
 * Shape conforming to @bch-wc2/interfaces WcSourceOutput:
 * Input & Output & ContractInfo
 */
export interface WcSourceOutput {
  outpointIndex: number;
  outpointTransactionHash: Uint8Array;
  sequenceNumber: number;
  unlockingBytecode: Uint8Array;
  valueSatoshis: bigint;
  lockingBytecode: Uint8Array;
  token?:
    | {
        category: Uint8Array;
        amount: bigint;
        nft?: {
          capability: 'none' | 'mutable' | 'minting';
          commitment: Uint8Array;
        };
      }
    | undefined;
  contract?: WcContractInfo | undefined;
}

/**
 * Shape conforming to @bch-wc2/interfaces WcSignTransactionRequest
 */
export interface WcSignTransactionRequest {
  transaction: Transaction | string;
  sourceOutputs: WcSourceOutput[];
  broadcast?: boolean | undefined;
  userPrompt?: string | undefined;
}

export interface UnsignedLockTransaction {
  transaction: Transaction;
  txHex: string;
  txid: string;
  sourceOutputs: WcSourceOutput[];
  wcSignRequest: WcSignTransactionRequest;
}

export interface SignedLockTransaction {
  transaction: Transaction;
  txHex: string;
  txid: string;
}

export interface SelectLockInputsOptions {
  utxos: Array<LockUtxo | ElectrumUtxo | unknown>;
  tokenCategory: string | Uint8Array;
  tokenAmount: bigint | number;
  bchCarrySats?: bigint | number | undefined;
  tokenChangeCarrySats?: bigint | number | undefined;
  feeRateSatPerByte?: number | undefined;
  userLockingBytecode?: Uint8Array | string | undefined;
  userAddress?: string | undefined;
}

export interface SelectedLockInputs {
  tokenInputs: LockUtxo[];
  bchInputs: LockUtxo[];
  allInputs: LockUtxo[];
  totalTokenAmount: bigint;
  totalSatoshis: bigint;
  hasTokenChange: boolean;
  tokenChangeAmount: bigint;
  estimatedFeeSats: bigint;
}

export interface BuildLockTxOptions {
  params: BchHtlcParameters | HtlcInputTerms | OrderTerms;
  inputs?: Array<LockUtxo | ElectrumUtxo | unknown> | undefined;
  utxos?: Array<LockUtxo | ElectrumUtxo | unknown> | undefined;
  selectedInputs?: SelectedLockInputs | undefined;
  changeAddress: string;
  tokenChangeAddress?: string | undefined;
  bchCarrySats?: bigint | number | undefined;
  tokenChangeCarrySats?: bigint | number | undefined;
  feeSats?: bigint | number | undefined;
  feeRateSatPerByte?: number | undefined;
  dustLimitSats?: bigint | number | undefined;
  wif?: string | undefined;
  privateKey?: Uint8Array | undefined;
  network?: CashAddressNetwork | undefined;
  provider?: NetworkProvider | undefined;
  userPrompt?: string | undefined;
}

export interface BuildLockTxResult {
  unsigned: UnsignedLockTransaction;
  signed?: SignedLockTransaction | undefined;
  htlcOutputIndex: number;
  htlcP2sh32Address: string;
  htlcTokenAddress: string;
  htlcLockingBytecode: Uint8Array;
  feeSats: bigint;
  tokenChangeAmount: bigint;
  bchChangeSats: bigint;
  selectedInputs: SelectedLockInputs;
}

/**
 * Compute the txid (RPC display format: reversed sha256d) of a raw tx hex string.
 */
function computeTxId(txHex: string): string {
  const raw = hexToBin(txHex);
  const hash = sha256.hash(sha256.hash(raw));
  const reversed = new Uint8Array(hash.length);
  for (let i = 0; i < hash.length; i++) {
    reversed[i] = hash[hash.length - 1 - i]!;
  }
  return binToHex(reversed);
}

/**
 * Normalise any UTXO format (ElectrumUtxo, CashScript Utxo, LockUtxo) to LockUtxo.
 */
export function normaliseLockUtxo(
  u: unknown,
  defaultLockingBytecode?: Uint8Array | undefined,
): LockUtxo {
  if (!u || typeof u !== 'object') {
    throw new Error(`Invalid UTXO object: ${JSON.stringify(u)}`);
  }
  const obj = u as Record<string, unknown>;

  const txid = (obj.txid ?? obj.tx_hash) as string;
  if (!txid || typeof txid !== 'string') {
    throw new Error(`UTXO missing txid/tx_hash: ${JSON.stringify(u)}`);
  }

  const vout = (obj.vout ?? obj.tx_pos) as number;
  if (typeof vout !== 'number') {
    throw new Error(`UTXO missing vout/tx_pos: ${JSON.stringify(u)}`);
  }

  const satsRaw = obj.satoshis ?? obj.value;
  if (satsRaw === undefined) {
    throw new Error(`UTXO missing satoshis/value: ${JSON.stringify(u)}`);
  }
  const satoshis = BigInt(satsRaw as string | number | bigint);

  let lockingBytecode: Uint8Array | undefined;
  if (obj.lockingBytecode) {
    lockingBytecode =
      typeof obj.lockingBytecode === 'string'
        ? resolveLockingBytecode(obj.lockingBytecode)
        : (obj.lockingBytecode as Uint8Array);
  } else if (defaultLockingBytecode) {
    lockingBytecode = defaultLockingBytecode;
  }

  let token: LockUtxo['token'];
  const tokenData = (obj.token ?? obj.token_data) as
    Record<string, unknown> | undefined;
  if (tokenData && typeof tokenData === 'object') {
    const cat = tokenData.category as string;
    const amt = BigInt((tokenData.amount ?? 0) as string | number | bigint);
    token = {
      category: cat.toLowerCase(),
      amount: amt,
      ...(tokenData.nft
        ? { nft: tokenData.nft as NonNullable<LockUtxo['token']>['nft'] }
        : {}),
    };
  }

  return {
    txid,
    vout,
    satoshis,
    ...(lockingBytecode ? { lockingBytecode } : {}),
    ...(token ? { token } : {}),
  };
}

/**
 * Estimate lock transaction miner fee in satoshis with safety margin.
 */
export function estimateLockFee(
  inputCount: number,
  outputCount: number,
  feeRateSatPerByte = 1.2,
  marginSats = 150n,
): bigint {
  const vbytes = 10 + inputCount * 148 + 77 + Math.max(0, outputCount - 1) * 50;
  const base = BigInt(Math.ceil(vbytes * feeRateSatPerByte));
  return base + marginSats;
}

/**
 * Deterministically select lock inputs from a list of UTXOs (e.g. from Fulcrum with include_tokens).
 *
 * Rules:
 * - Refuses any UTXO carrying an NFT
 * - Refuses any UTXO carrying a different token category
 * - Token inputs: sorted descending by token amount (largest first; deterministic tie-break)
 * - BCH inputs: sorted ascending by satoshis (smallest sufficient single UTXO, or smallest ascending subset)
 */
export function selectLockInputs(
  options: SelectLockInputsOptions,
): SelectedLockInputs {
  const targetCategoryHex = (
    typeof options.tokenCategory === 'string'
      ? options.tokenCategory
      : binToHex(options.tokenCategory)
  )
    .trim()
    .toLowerCase();

  const targetAmount = BigInt(options.tokenAmount);
  if (targetAmount <= 0n) {
    throw new Error(
      `Token amount must be greater than zero, got ${targetAmount}`,
    );
  }

  const bchCarrySats = BigInt(options.bchCarrySats ?? 3000n);
  const tokenChangeCarrySats = BigInt(options.tokenChangeCarrySats ?? 1000n);
  const feeRate = options.feeRateSatPerByte ?? 1.2;

  let defaultLockingBytecode: Uint8Array | undefined;
  if (options.userLockingBytecode) {
    defaultLockingBytecode = resolveLockingBytecode(
      options.userLockingBytecode,
    );
  } else if (options.userAddress) {
    defaultLockingBytecode = resolveLockingBytecode(options.userAddress);
  }

  const normalisedUtxos = options.utxos.map((u) =>
    normaliseLockUtxo(u, defaultLockingBytecode),
  );

  const candidateTokenUtxos: LockUtxo[] = [];
  const candidateBchUtxos: LockUtxo[] = [];

  for (const u of normalisedUtxos) {
    if (u.token) {
      if (u.token.nft) {
        // Never spend a UTXO carrying an NFT
        continue;
      }
      if (u.token.category !== targetCategoryHex) {
        // Never spend a UTXO carrying a different category
        continue;
      }
      if (u.token.amount > 0n) {
        candidateTokenUtxos.push(u);
      } else {
        candidateBchUtxos.push(u);
      }
    } else {
      candidateBchUtxos.push(u);
    }
  }

  // Sort candidate token UTXOs descending by token amount
  candidateTokenUtxos.sort((a, b) => {
    if (b.token!.amount !== a.token!.amount) {
      return b.token!.amount > a.token!.amount ? 1 : -1;
    }
    const cmp = a.txid.localeCompare(b.txid);
    if (cmp !== 0) return cmp;
    return a.vout - b.vout;
  });

  // Select token UTXOs (largest first)
  const selectedTokenInputs: LockUtxo[] = [];
  let accumulatedTokens = 0n;
  for (const u of candidateTokenUtxos) {
    selectedTokenInputs.push(u);
    accumulatedTokens += u.token!.amount;
    if (accumulatedTokens >= targetAmount) {
      break;
    }
  }

  if (accumulatedTokens < targetAmount) {
    throw new Error(
      `Insufficient token balance for category ${targetCategoryHex}: required ${targetAmount}, available ${accumulatedTokens}`,
    );
  }

  const hasTokenChange = accumulatedTokens > targetAmount;
  const tokenChangeAmount = accumulatedTokens - targetAmount;

  const tokenInputsSatoshis = selectedTokenInputs.reduce(
    (sum, u) => sum + u.satoshis,
    0n,
  );

  // Estimate required satoshis
  const expectedOutputsCount = 1 + (hasTokenChange ? 1 : 0) + 1;
  const estimatedInitialFee = estimateLockFee(
    selectedTokenInputs.length + 1,
    expectedOutputsCount,
    feeRate,
  );

  const baseRequiredSats =
    bchCarrySats +
    (hasTokenChange ? tokenChangeCarrySats : 0n) +
    estimatedInitialFee;

  const selectedBchInputs: LockUtxo[] = [];
  let currentTotalSatoshis = tokenInputsSatoshis;

  if (currentTotalSatoshis < baseRequiredSats) {
    const deficitSats = baseRequiredSats - currentTotalSatoshis;

    // Sort pure BCH UTXOs ascending by satoshis (smallest first; deterministic tie-break)
    candidateBchUtxos.sort((a, b) => {
      if (a.satoshis !== b.satoshis) {
        return a.satoshis > b.satoshis ? 1 : -1;
      }
      const cmp = a.txid.localeCompare(b.txid);
      if (cmp !== 0) return cmp;
      return a.vout - b.vout;
    });

    // Check if there is a single pure BCH UTXO that is sufficient by itself
    const singleSufficient = candidateBchUtxos.find(
      (u) => u.satoshis >= deficitSats,
    );

    if (singleSufficient) {
      selectedBchInputs.push(singleSufficient);
      currentTotalSatoshis += singleSufficient.satoshis;
    } else {
      // Accumulate smallest pure BCH UTXOs until sufficient
      for (const u of candidateBchUtxos) {
        selectedBchInputs.push(u);
        currentTotalSatoshis += u.satoshis;
        const currentTotalInputs =
          selectedTokenInputs.length + selectedBchInputs.length;
        const currentFee = estimateLockFee(
          currentTotalInputs,
          expectedOutputsCount,
          feeRate,
        );
        const currentRequired =
          bchCarrySats +
          (hasTokenChange ? tokenChangeCarrySats : 0n) +
          currentFee;
        if (currentTotalSatoshis >= currentRequired) {
          break;
        }
      }
    }
  }

  const finalTotalInputs =
    selectedTokenInputs.length + selectedBchInputs.length;
  const finalFee = estimateLockFee(
    finalTotalInputs,
    expectedOutputsCount,
    feeRate,
  );
  const finalRequired =
    bchCarrySats + (hasTokenChange ? tokenChangeCarrySats : 0n) + finalFee;

  if (currentTotalSatoshis < finalRequired) {
    throw new Error(
      `Insufficient BCH balance for fees and carry satoshis: required ${finalRequired}, available ${currentTotalSatoshis}`,
    );
  }

  return {
    tokenInputs: selectedTokenInputs,
    bchInputs: selectedBchInputs,
    allInputs: [...selectedTokenInputs, ...selectedBchInputs],
    totalTokenAmount: accumulatedTokens,
    totalSatoshis: currentTotalSatoshis,
    hasTokenChange,
    tokenChangeAmount,
    estimatedFeeSats: finalFee,
  };
}

/**
 * Build a complete lock/funding transaction.
 *
 * Produces:
 * - unsigned: Transaction object, raw txHex, sourceOutputs array, and wcSignRequest (WizardConnect format)
 * - signed: signed Transaction and txHex (if wif or privateKey provided)
 */
export function buildLockTransaction(
  options: BuildLockTxOptions,
): BuildLockTxResult {
  const network = options.network ?? 'chipnet';
  const canonicalParams = encodeHtlcParameters(options.params);
  const htlcDerivation = deriveHtlcAddresses(canonicalParams, network);

  const rawCarry =
    options.bchCarrySats ??
    (options.params && 'bchCarrySats' in options.params
      ? (options.params as { bchCarrySats?: bigint | number }).bchCarrySats
      : undefined);
  const bchCarrySats = BigInt(rawCarry ?? 3000n);
  const tokenChangeCarrySats = BigInt(options.tokenChangeCarrySats ?? 1000n);
  const dustLimitSats = BigInt(options.dustLimitSats ?? 546n);

  const changeLockingBytecode = resolveLockingBytecode(options.changeAddress);
  const tokenChangeLockingBytecode = options.tokenChangeAddress
    ? resolveLockingBytecode(options.tokenChangeAddress)
    : changeLockingBytecode;

  const displayCategory = internalToDisplayCategory(
    canonicalParams.tokenCategory,
  ).toLowerCase();

  let selected: SelectedLockInputs;
  if (options.selectedInputs) {
    selected = options.selectedInputs;
  } else {
    const rawUtxos = options.inputs ?? options.utxos;
    if (!rawUtxos || rawUtxos.length === 0) {
      throw new Error(
        'buildLockTransaction requires inputs, utxos, or selectedInputs',
      );
    }
    selected = selectLockInputs({
      utxos: rawUtxos,
      tokenCategory: displayCategory,
      tokenAmount: canonicalParams.tokenAmount,
      bchCarrySats,
      tokenChangeCarrySats,
      ...(options.feeRateSatPerByte !== undefined
        ? { feeRateSatPerByte: options.feeRateSatPerByte }
        : {}),
      userLockingBytecode: changeLockingBytecode,
    });
  }

  // Ensure all selected inputs have locking bytecode
  for (const input of selected.allInputs) {
    if (!input.lockingBytecode) {
      input.lockingBytecode = changeLockingBytecode;
    }
  }

  for (const input of selected.tokenInputs) {
    if (!input.token) {
      throw new Error(
        `Selected token input ${input.txid}:${input.vout} has no token data`,
      );
    }
    if (input.token.nft) {
      throw new Error(
        `Selected token input ${input.txid}:${input.vout} carries an NFT, which is forbidden`,
      );
    }
    if (input.token.category.toLowerCase() !== displayCategory) {
      throw new Error(
        `Selected token input category mismatch: expected ${displayCategory}, got ${input.token.category}`,
      );
    }
  }

  if (selected.totalTokenAmount < canonicalParams.tokenAmount) {
    throw new Error(
      `Insufficient token amount: required ${canonicalParams.tokenAmount}, selected ${selected.totalTokenAmount}`,
    );
  }

  // Calculate fee and change
  let feeSats =
    options.feeSats !== undefined
      ? BigInt(options.feeSats)
      : selected.estimatedFeeSats;

  const totalInSats = selected.totalSatoshis;
  const tokenChangeAmount =
    selected.totalTokenAmount - canonicalParams.tokenAmount;
  const hasTokenChange = tokenChangeAmount > 0n;

  const baseAllocatedSats =
    bchCarrySats + (hasTokenChange ? tokenChangeCarrySats : 0n) + feeSats;

  if (totalInSats < baseAllocatedSats) {
    throw new Error(
      `Total input satoshis (${totalInSats}) insufficient for carry (${bchCarrySats}), token change carry (${hasTokenChange ? tokenChangeCarrySats : 0n}), and fee (${feeSats})`,
    );
  }

  const remainingBch = totalInSats - baseAllocatedSats;
  let bchChangeSats = 0n;

  if (remainingBch >= dustLimitSats) {
    bchChangeSats = remainingBch;
  } else if (remainingBch > 0n) {
    // Under dust limit: absorb remaining satoshis into fee to respect dust rules
    feeSats += remainingBch;
    bchChangeSats = 0n;
  }

  // Build outputs
  const categoryBytes = hexToBin(displayCategory);
  const outputs: Output[] = [];

  // Output 0: HTLC P2SH32 output
  outputs.push({
    lockingBytecode: htlcDerivation.lockingBytecode,
    valueSatoshis: bchCarrySats,
    token: {
      category: categoryBytes,
      amount: canonicalParams.tokenAmount,
    },
  });

  // Output 1 (conditional): Token change
  if (hasTokenChange) {
    outputs.push({
      lockingBytecode: tokenChangeLockingBytecode,
      valueSatoshis: tokenChangeCarrySats,
      token: {
        category: categoryBytes,
        amount: tokenChangeAmount,
      },
    });
  }

  // Output 2 (conditional): BCH change
  if (bchChangeSats > 0n) {
    outputs.push({
      lockingBytecode: changeLockingBytecode,
      valueSatoshis: bchChangeSats,
    });
  }

  // Construct Libauth unsigned transaction
  const unsignedLibauthTx: Transaction = {
    version: 2,
    inputs: selected.allInputs.map((u) => ({
      outpointIndex: u.vout,
      outpointTransactionHash: hexToBin(u.txid),
      sequenceNumber: 0,
      unlockingBytecode: new Uint8Array(0),
    })),
    outputs,
    locktime: 0,
  };

  const unsignedTxBytes = encodeTransaction(unsignedLibauthTx);
  const unsignedTxHex = binToHex(unsignedTxBytes);
  const unsignedTxid = computeTxId(unsignedTxHex);

  // Construct WizardConnect source outputs matching WcSourceOutput shape
  const sourceOutputs: WcSourceOutput[] = selected.allInputs.map((u) => ({
    outpointIndex: u.vout,
    outpointTransactionHash: hexToBin(u.txid),
    sequenceNumber: 0,
    unlockingBytecode: new Uint8Array(0),
    valueSatoshis: u.satoshis,
    lockingBytecode: u.lockingBytecode ?? changeLockingBytecode,
    ...(u.token
      ? {
          token: {
            category: hexToBin(u.token.category),
            amount: u.token.amount,
          },
        }
      : {}),
  }));

  const wcSignRequest: WcSignTransactionRequest = {
    transaction: unsignedTxHex,
    sourceOutputs,
    broadcast: false,
    userPrompt:
      options.userPrompt ??
      `Lock ${canonicalParams.tokenAmount} tokens into Ferry HTLC`,
  };

  const unsignedResult: UnsignedLockTransaction = {
    transaction: unsignedLibauthTx,
    txHex: unsignedTxHex,
    txid: unsignedTxid,
    sourceOutputs,
    wcSignRequest,
  };

  let signedResult: SignedLockTransaction | undefined;

  // If WIF or private key provided, sign with CashScript
  if (options.wif || options.privateKey) {
    const mockProvider = options.provider ?? new MockNetworkProvider();
    mockProvider.network =
      network === 'mainnet' ? Network.MAINNET : Network.CHIPNET;

    const sigTemplate = options.wif
      ? new SignatureTemplate(options.wif)
      : new SignatureTemplate(options.privateKey!);

    const tb = new TransactionBuilder({ provider: mockProvider });

    for (const u of selected.allInputs) {
      tb.addInput(
        {
          txid: u.txid,
          vout: u.vout,
          satoshis: u.satoshis,
          lockingBytecode: binToHex(u.lockingBytecode ?? changeLockingBytecode),
          ...(u.token
            ? {
                token: {
                  category: u.token.category,
                  amount: u.token.amount,
                },
              }
            : {}),
        },
        sigTemplate.unlockP2PKH(),
      );
    }

    for (const out of outputs) {
      tb.addOutput({
        to: out.lockingBytecode,
        amount: out.valueSatoshis,
        ...(out.token
          ? {
              token: {
                category: binToHex(out.token.category),
                amount: out.token.amount,
              },
            }
          : {}),
      });
    }

    const signedTxHex = tb.build();
    const signedTxid = computeTxId(signedTxHex);
    const decoded = decodeTransaction(hexToBin(signedTxHex));
    if (typeof decoded === 'string') {
      throw new Error(`Failed to decode signed transaction: ${decoded}`);
    }

    const sourceOutputs = selected.allInputs.map((input) => ({
      valueSatoshis: input.satoshis,
      lockingBytecode: input.lockingBytecode ?? changeLockingBytecode,
      ...(input.token
        ? {
            token: {
              category: hexToBin(input.token.category),
              amount: input.token.amount,
            },
          }
        : {}),
    }));

    const vmResult = verifyBchTransactionWithVm({
      transaction: decoded,
      sourceOutputs,
    });
    if (vmResult !== true) {
      throw new Error(`BCH lock script VM verification failed: ${vmResult}`);
    }

    signedResult = {
      transaction: decoded,
      txHex: signedTxHex,
      txid: signedTxid,
    };
  }

  return {
    unsigned: unsignedResult,
    ...(signedResult ? { signed: signedResult } : {}),
    htlcOutputIndex: 0,
    htlcP2sh32Address: htlcDerivation.p2sh32Address,
    htlcTokenAddress: htlcDerivation.tokenAddress,
    htlcLockingBytecode: htlcDerivation.lockingBytecode,
    feeSats,
    tokenChangeAmount,
    bchChangeSats,
    selectedInputs: selected,
  };
}
