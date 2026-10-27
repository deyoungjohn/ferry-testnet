import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeCashAddress,
  decodeTransaction,
  hexToBin,
  sha256,
  type Transaction,
} from '@bitauth/libauth';
import {
  buildLockTransaction,
  displayToInternalCategory,
  type BchHtlcParameters,
} from '@ferry/htlc-bch';
import {
  addressFromLockingBytecode,
  type BchAddressInfo,
} from '../bch/address';
import { BCH_ELECTRUM_URL } from '../config';
import { ElectrumClient, type ElectrumUtxo } from '../../recover/core';

const PROVIDER_SETTLE_MS = 250;
const SPIKE_PROMPT =
  'Ferry extension probe: sign a chipnet token lock (not broadcast)';
const SPIKE_HASH_LOCK = sha256.hash(
  new TextEncoder().encode('ferry-wallet-extension-spike-v1'),
);
const SPIKE_TOKEN_AMOUNT = 1n;
const SPIKE_REFUND_BLOCKS = 144;

export interface ExtensionSignRequest {
  readonly transaction: Transaction;
  readonly sourceOutputs: readonly unknown[];
  readonly broadcast: boolean;
  readonly userPrompt: string;
}

export interface ExtensionSignResponse {
  readonly signedTransaction: string;
  readonly signedTransactionHash?: string;
}

export interface PaytacaProvider {
  connect(): Promise<unknown>;
  address(): Promise<string | undefined>;
  connected?: () => Promise<boolean>;
  signTransaction(
    request: ExtensionSignRequest,
  ): Promise<ExtensionSignResponse | undefined>;
}

export interface ProviderDetection {
  readonly paytaca: PaytacaProvider | null;
  readonly hasSeleneGlobal: boolean;
}

export interface SpikeFunding {
  readonly tipHeight: number;
  readonly utxos: readonly ElectrumUtxo[];
}

export interface SpikeTokenLock {
  readonly txHex: string;
  readonly txid: string;
  readonly p2sh32Address: string;
  readonly p2sh32LockingBytecode: string;
  readonly tokenAddress: string;
  readonly tokenCategory: string;
  readonly tokenAmount: bigint;
  readonly feeSats: bigint;
  readonly request: ExtensionSignRequest;
}

export interface SignedSpikeLock {
  readonly txid: string;
  readonly inputCount: number;
  readonly signedInputs: number;
  readonly tokenCategory: string;
  readonly tokenAmount: bigint;
  readonly p2sh32LockingBytecode: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function asPaytacaProvider(value: unknown): PaytacaProvider | null {
  const record = asRecord(value);
  if (!record) return null;
  const connect = record.connect;
  const address = record.address;
  const signTransaction = record.signTransaction;
  const connected = record.connected;
  if (
    typeof connect !== 'function' ||
    typeof address !== 'function' ||
    typeof signTransaction !== 'function'
  ) {
    return null;
  }
  return {
    connect: () => connect.call(value) as Promise<unknown>,
    address: () => address.call(value) as Promise<string | undefined>,
    ...(typeof connected === 'function'
      ? {
          connected: () => connected.call(value) as Promise<boolean>,
        }
      : {}),
    signTransaction: (request) =>
      signTransaction.call(value, request) as Promise<
        ExtensionSignResponse | undefined
      >,
  };
}

export function detectProvider(
  value: unknown = globalThis.window,
): ProviderDetection {
  const record = asRecord(value);
  return {
    paytaca: asPaytacaProvider(record?.paytaca),
    hasSeleneGlobal: Boolean(record?.selene),
  };
}

export async function waitForProvider(
  timeoutMs = PROVIDER_SETTLE_MS,
  windowValue: unknown = globalThis.window,
): Promise<ProviderDetection> {
  const immediate = detectProvider(windowValue);
  if (immediate.paytaca || timeoutMs <= 0) return immediate;
  await new Promise((resolve) => globalThis.setTimeout(resolve, timeoutMs));
  return detectProvider(windowValue);
}

export function normalizeProviderAddress(input: string): BchAddressInfo {
  const address = input.trim();
  const separator = address.indexOf(':');
  if (separator < 0) {
    throw new Error('The wallet returned an address without a network prefix');
  }
  const prefix = address.slice(0, separator).toLowerCase();
  if (prefix !== 'bchtest') {
    throw new Error(
      'Switch the wallet to chipnet. This probe only accepts bchtest: addresses.',
    );
  }
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string') {
    throw new Error('The wallet returned an invalid CashAddress');
  }
  if (decoded.type !== 'p2pkh' && decoded.type !== 'p2pkhWithTokens') {
    throw new Error('The wallet returned an address that is not P2PKH');
  }
  const locking = cashAddressToLockingBytecode(address);
  if (typeof locking === 'string') {
    throw new Error('The wallet address could not be decoded');
  }
  return addressFromLockingBytecode(`0x${binToHex(locking.bytecode)}`);
}

function addressFromConnectResult(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) return null;
  if (record.connected === false) {
    throw new Error('The wallet did not approve the connection');
  }
  return typeof record.address === 'string' ? record.address : null;
}

export async function connectPaytaca(
  provider: PaytacaProvider,
): Promise<BchAddressInfo> {
  const result = await provider.connect();
  const fromConnect = addressFromConnectResult(result);
  const fromAddress = fromConnect ? null : await provider.address();
  const raw = fromConnect ?? fromAddress;
  if (!raw) throw new Error('The wallet returned no address');
  return normalizeProviderAddress(raw);
}

export async function readSpikeFunding(
  address: BchAddressInfo,
  electrumUrl: string = BCH_ELECTRUM_URL,
): Promise<SpikeFunding> {
  const electrum = new ElectrumClient(electrumUrl);
  try {
    await electrum.connect();
    const [tipHeight, utxos] = await Promise.all([
      electrum.tipHeight(),
      electrum.listUnspent(address.lockingBytecode),
    ]);
    return { tipHeight, utxos };
  } finally {
    electrum.close();
  }
}

function tokenUtxos(utxos: readonly ElectrumUtxo[]): ElectrumUtxo[] {
  return utxos
    .filter(
      (utxo) =>
        utxo.category !== null &&
        utxo.amount !== null &&
        utxo.amount >= SPIKE_TOKEN_AMOUNT,
    )
    .sort((left, right) => {
      if (left.amount === right.amount) {
        return left.txid.localeCompare(right.txid) || left.vout - right.vout;
      }
      return (right.amount ?? 0n) > (left.amount ?? 0n) ? 1 : -1;
    });
}

export function buildSpikeTokenLock(options: {
  readonly address: BchAddressInfo;
  readonly funding: SpikeFunding;
}): SpikeTokenLock {
  const candidates = tokenUtxos(options.funding.utxos);
  const tokenUtxo = candidates[0];
  if (!tokenUtxo || !tokenUtxo.category || tokenUtxo.amount === null) {
    throw new Error(
      'No CashToken UTXO at this address. Send a small chipnet token to test a P2SH32 token lock.',
    );
  }
  const lockingBytecode = hexToBin(options.address.lockingBytecode.slice(2));
  const category = tokenUtxo.category.toLowerCase().replace(/^0x/, '');
  const params: BchHtlcParameters = {
    hashLock: SPIKE_HASH_LOCK,
    recipientLockingBytecode: lockingBytecode,
    refundLockingBytecode: lockingBytecode,
    tokenCategory: displayToInternalCategory(category),
    tokenAmount: SPIKE_TOKEN_AMOUNT,
    refundHeight: options.funding.tipHeight + SPIKE_REFUND_BLOCKS,
    maxFee: 1_500n,
  };
  const built = buildLockTransaction({
    params,
    utxos: options.funding.utxos.map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
      lockingBytecode,
      ...(utxo.category !== null && utxo.amount !== null
        ? { token: { category: utxo.category, amount: utxo.amount } }
        : {}),
    })),
    changeAddress: options.address.address,
    network: 'chipnet',
    userPrompt: SPIKE_PROMPT,
  });
  return {
    txHex: built.unsigned.txHex,
    txid: built.unsigned.txid,
    p2sh32Address: built.htlcP2sh32Address,
    p2sh32LockingBytecode: `0x${binToHex(built.htlcLockingBytecode)}`,
    tokenAddress: built.htlcTokenAddress,
    tokenCategory: category,
    tokenAmount: SPIKE_TOKEN_AMOUNT,
    feeSats: built.feeSats,
    request: {
      transaction: built.unsigned.transaction,
      sourceOutputs: built.unsigned.sourceOutputs,
      broadcast: false,
      userPrompt: SPIKE_PROMPT,
    },
  };
}

export function signSpikeLock(
  provider: PaytacaProvider,
  lock: SpikeTokenLock,
): Promise<ExtensionSignResponse | undefined> {
  return provider.signTransaction(lock.request);
}

function txidOf(txHex: string): string {
  const bytes = hexToBin(txHex.replace(/^0x/, ''));
  const first = sha256.hash(bytes);
  const second = sha256.hash(first);
  second.reverse();
  return binToHex(second);
}

export function inspectSignedSpikeLock(
  signedTransaction: string,
  lock: SpikeTokenLock,
): SignedSpikeLock {
  const clean = signedTransaction.trim().replace(/^0x/, '');
  if (!clean || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('The wallet returned invalid transaction hex');
  }
  const decoded = decodeTransaction(hexToBin(clean));
  if (typeof decoded === 'string') {
    throw new Error(`The wallet returned an invalid transaction: ${decoded}`);
  }
  const signedInputs = decoded.inputs.filter(
    (input) => input.unlockingBytecode.length > 0,
  ).length;
  if (decoded.inputs.length === 0 || signedInputs !== decoded.inputs.length) {
    throw new Error('The wallet returned an unsigned transaction');
  }
  const output = decoded.outputs[0];
  if (!output) throw new Error('The signed transaction has no outputs');
  if (
    binToHex(output.lockingBytecode) !==
    lock.p2sh32LockingBytecode.replace(/^0x/, '')
  ) {
    throw new Error('The signed transaction does not pay the test P2SH32 lock');
  }
  if (!output.token || output.token.amount !== lock.tokenAmount) {
    throw new Error('The signed transaction does not carry the expected token');
  }
  if (
    binToHex(output.token.category) !== lock.tokenCategory.replace(/^0x/, '')
  ) {
    throw new Error('The signed transaction has an unexpected token category');
  }
  return {
    txid: txidOf(clean),
    inputCount: decoded.inputs.length,
    signedInputs,
    tokenCategory: binToHex(output.token.category),
    tokenAmount: output.token.amount,
    p2sh32LockingBytecode: binToHex(output.lockingBytecode),
  };
}
