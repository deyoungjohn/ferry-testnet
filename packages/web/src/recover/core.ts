import { evmLockId, orderId as computeOrderId, type Hex32 } from '@ferry/core';
import {
  buildClaimTransaction,
  buildRefundTransaction,
  deriveHtlcAddresses,
} from '@ferry/htlc-bch';
import { ferryHtlcAbi } from '@ferry/htlc-evm/abi';
import {
  bytesToHex,
  decodeFunctionResult,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  sha256,
  type Address,
  type Hex,
} from 'viem';
import {
  assertRecoveryNetwork,
  bchParametersFromTerms,
  RecoveryFileSchema,
  type RecoveryFile,
} from '../lib/recovery';

export interface RecoveryEndpoints {
  readonly electrumUrl: string;
  readonly baseRpcUrl: string;
}

export interface ElectrumUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: bigint;
  readonly height: number;
  readonly category: string | null;
  readonly amount: bigint | null;
}

export interface EvmLockView {
  readonly token: Address;
  readonly sender: Address;
  readonly recipient: Address;
  readonly amount: bigint;
  readonly hashLock: Hex32;
  readonly deadline: bigint;
  readonly state: number;
}

export type BchRecoveryState =
  | {
      readonly ok: true;
      readonly tipHeight: number;
      readonly utxo: ElectrumUtxo | null;
    }
  | { readonly ok: false; readonly error: string };

export type EvmRecoveryState =
  | {
      readonly ok: true;
      readonly chainId: number;
      readonly blockTimestamp: number;
      readonly lock: EvmLockView;
    }
  | { readonly ok: false; readonly error: string };

export interface RecoverySnapshot {
  readonly file: RecoveryFile;
  readonly bch: BchRecoveryState;
  readonly evm: EvmRecoveryState;
}

export interface Eip1193Provider {
  request(args: {
    readonly method: string;
    readonly params?: readonly unknown[] | object;
  }): Promise<unknown>;
}

function hexFromBytes(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function parseRecoveryJson(json: string): RecoveryFile {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Recovery file is not valid JSON');
  }
  return RecoveryFileSchema.parse(raw);
}

export function validateRecoveryFile(file: RecoveryFile): RecoveryFile {
  assertRecoveryNetwork(file);
  if (computeOrderId(file.terms) !== file.orderId) {
    throw new Error('Recovery file order id does not match its terms');
  }
  const parameters = bchParametersFromTerms(file.terms);
  const addresses = deriveHtlcAddresses(parameters, file.contracts.bch.network);
  if (addresses.p2sh32Address !== file.contracts.bch.htlcAddress) {
    throw new Error('BCH HTLC address does not match the recovered terms');
  }
  if (addresses.tokenAddress !== file.contracts.bch.tokenAddress) {
    throw new Error('BCH token address does not match the recovered terms');
  }
  if (
    hexFromBytes(addresses.redeemScript) !== file.contracts.bch.redeemScript
  ) {
    throw new Error('BCH redeem script does not match the recovered terms');
  }
  if (
    hexFromBytes(addresses.lockingBytecode) !==
    file.contracts.bch.lockingBytecode
  ) {
    throw new Error('BCH locking bytecode does not match the recovered terms');
  }
  const codeHash = keccak256(file.contracts.evm.bytecode as Hex);
  if (codeHash.toLowerCase() !== file.contracts.evm.codeHash.toLowerCase()) {
    throw new Error('EVM contract bytecode hash does not match');
  }
  return file;
}

export function electrumScripthash(lockingBytecode: Hex): string {
  const hash = hexToBytes(sha256(lockingBytecode));
  hash.reverse();
  return bytesToHex(hash).slice(2);
}

function normalizeCategory(category: string): string {
  return category.toLowerCase().replace(/^0x/, '');
}

export function findHtlcUtxo(
  utxos: readonly ElectrumUtxo[],
  file: RecoveryFile,
): ElectrumUtxo | null {
  const category = normalizeCategory(file.terms.bchTokenCategory);
  return (
    utxos.find(
      (utxo) =>
        utxo.category !== null &&
        normalizeCategory(utxo.category) === category &&
        utxo.amount === file.terms.bchTokenAmount,
    ) ?? null
  );
}

type JsonRpcResponse = {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

async function rpcRequest<T>(
  url: string,
  method: string,
  params: readonly unknown[],
): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC returned HTTP ${response.status}`);
  }
  const body = (await response.json()) as JsonRpcResponse;
  if (body.error) {
    throw new Error(body.error.message ?? 'RPC request failed');
  }
  return body.result as T;
}

export class ElectrumClient {
  readonly #url: string;
  #socket: WebSocket | null = null;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
      readonly timer: number;
    }
  >();

  constructor(url: string) {
    this.#url = url;
  }

  async connect(): Promise<void> {
    if (this.#socket) return;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error('Electrum connection timed out'));
      }, 10_000);
      socket.onopen = () => {
        window.clearTimeout(timer);
        this.#socket = socket;
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('Could not connect to Electrum'));
      };
      socket.onmessage = (event) => {
        let message: JsonRpcResponse;
        try {
          message = JSON.parse(String(event.data)) as JsonRpcResponse;
        } catch {
          return;
        }
        if (typeof message.id !== 'number') return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        window.clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(
            new Error(message.error.message ?? 'Electrum request failed'),
          );
        } else {
          pending.resolve(message.result);
        }
      };
      socket.onclose = () => {
        this.#socket = null;
        for (const pending of this.#pending.values()) {
          window.clearTimeout(pending.timer);
          pending.reject(new Error('Electrum connection closed'));
        }
        this.#pending.clear();
      };
    });
    await this.request('server.version', ['Ferry recover', '1.4']);
  }

  async request<T>(method: string, params: readonly unknown[]): Promise<T> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Electrum is not connected');
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('Electrum request timed out'));
      }, 15_000);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  async tipHeight(): Promise<number> {
    const header = await this.request<{ readonly height: number }>(
      'blockchain.headers.subscribe',
      [],
    );
    return header.height;
  }

  async listUnspent(lockingBytecode: Hex): Promise<ElectrumUtxo[]> {
    const result = await this.request<
      readonly {
        readonly tx_hash: string;
        readonly tx_pos: number;
        readonly value: number | string;
        readonly height?: number;
        readonly token_data?: {
          readonly category?: string;
          readonly amount?: string | number;
        };
      }[]
    >('blockchain.scripthash.listunspent', [
      electrumScripthash(lockingBytecode),
      'include_tokens',
    ]);
    return result.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: BigInt(utxo.value),
      height: utxo.height ?? 0,
      category: utxo.token_data?.category ?? null,
      amount:
        utxo.token_data?.amount === undefined
          ? null
          : BigInt(utxo.token_data.amount),
    }));
  }

  async broadcast(txHex: string): Promise<string> {
    return this.request<string>('blockchain.transaction.broadcast', [
      txHex.replace(/^0x/, ''),
    ]);
  }

  async transactionGet(txid: string): Promise<string> {
    return this.request<string>('blockchain.transaction.get', [txid, false]);
  }

  async transactionExists(txid: string): Promise<boolean> {
    try {
      await this.transactionGet(txid);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.#socket?.close();
    this.#socket = null;
  }
}

export class BaseRpcClient {
  readonly #url: string;

  constructor(url: string) {
    this.#url = url;
  }

  async chainId(): Promise<number> {
    const value = await rpcRequest<string>(this.#url, 'eth_chainId', []);
    return Number.parseInt(value, 16);
  }

  async code(address: Address): Promise<Hex> {
    return rpcRequest<Hex>(this.#url, 'eth_getCode', [address, 'latest']);
  }

  async blockTimestamp(): Promise<number> {
    const block = await rpcRequest<{ readonly timestamp: string }>(
      this.#url,
      'eth_getBlockByNumber',
      ['latest', false],
    );
    return Number(BigInt(block.timestamp));
  }

  async getLock(address: Address, lockId: Hex32): Promise<EvmLockView> {
    const data = encodeFunctionData({
      abi: ferryHtlcAbi,
      functionName: 'locks',
      args: [lockId],
    });
    const result = await rpcRequest<Hex>(this.#url, 'eth_call', [
      { to: address, data },
      'latest',
    ]);
    const decoded = decodeFunctionResult({
      abi: ferryHtlcAbi,
      functionName: 'locks',
      data: result,
    }) as readonly [
      Address,
      Address,
      Address,
      bigint,
      Hex32,
      bigint,
      number | bigint,
    ];
    return {
      token: decoded[0],
      sender: decoded[1],
      recipient: decoded[2],
      amount: decoded[3],
      hashLock: decoded[4],
      deadline: decoded[5],
      state: Number(decoded[6]),
    };
  }
}

export async function loadRecoverySnapshot(
  file: RecoveryFile,
  endpoints: RecoveryEndpoints,
): Promise<RecoverySnapshot> {
  const validated = validateRecoveryFile(file);
  const electrum = new ElectrumClient(endpoints.electrumUrl);
  let bch: BchRecoveryState;
  try {
    await electrum.connect();
    const [tipHeight, utxos] = await Promise.all([
      electrum.tipHeight(),
      electrum.listUnspent(validated.contracts.bch.lockingBytecode as Hex),
    ]);
    bch = { ok: true, tipHeight, utxo: findHtlcUtxo(utxos, validated) };
  } catch (cause) {
    bch = {
      ok: false,
      error:
        cause instanceof Error ? cause.message : 'Could not read the BCH chain',
    };
  } finally {
    electrum.close();
  }

  const base = new BaseRpcClient(endpoints.baseRpcUrl);
  let evm: EvmRecoveryState;
  try {
    const chainId = await base.chainId();
    if (chainId !== validated.contracts.evm.chainId) {
      throw new Error(
        `RPC chain id ${chainId} does not match the recovery file`,
      );
    }
    const code = await base.code(validated.contracts.evm.address as Address);
    if (code.toLowerCase() !== validated.contracts.evm.bytecode.toLowerCase()) {
      throw new Error(
        'The contract at the recovery address has different code',
      );
    }
    const lockId = evmLockId(
      validated.terms.userCounterAddress,
      validated.terms.hashLock,
    );
    const [lock, blockTimestamp] = await Promise.all([
      base.getLock(validated.contracts.evm.address as Address, lockId),
      base.blockTimestamp(),
    ]);
    evm = { ok: true, chainId, blockTimestamp, lock };
  } catch (cause) {
    evm = {
      ok: false,
      error:
        cause instanceof Error
          ? cause.message
          : 'Could not read the Base chain',
    };
  }

  return { file: validated, bch, evm };
}

export async function broadcastBchClaim(
  file: RecoveryFile,
  utxo: ElectrumUtxo,
  electrumUrl: string,
): Promise<string> {
  assertRecoveryNetwork(file);
  const built = buildClaimTransaction({
    params: bchParametersFromTerms(file.terms),
    network: file.contracts.bch.network,
    secret: file.secret,
    utxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
    },
    feeSats: 500n,
  });
  const electrum = new ElectrumClient(electrumUrl);
  try {
    await electrum.connect();
    return await electrum.broadcast(built.txHex);
  } finally {
    electrum.close();
  }
}

export async function broadcastBchRefund(
  file: RecoveryFile,
  utxo: ElectrumUtxo,
  electrumUrl: string,
): Promise<string> {
  assertRecoveryNetwork(file);
  const built = buildRefundTransaction({
    params: bchParametersFromTerms(file.terms),
    network: file.contracts.bch.network,
    utxo: {
      txid: utxo.txid,
      vout: utxo.vout,
      satoshis: utxo.satoshis,
    },
    feeSats: 500n,
  });
  const electrum = new ElectrumClient(electrumUrl);
  try {
    await electrum.connect();
    return await electrum.broadcast(built.txHex);
  } finally {
    electrum.close();
  }
}

export function evmRefundCalldata(file: RecoveryFile): Hex {
  const lockId = evmLockId(file.terms.userCounterAddress, file.terms.hashLock);
  return encodeFunctionData({
    abi: ferryHtlcAbi,
    functionName: 'refund',
    args: [lockId],
  });
}

export async function sendEvmRefund(
  file: RecoveryFile,
  provider: Eip1193Provider,
): Promise<string> {
  const accounts = (await provider.request({
    method: 'eth_requestAccounts',
  })) as readonly string[];
  const from = accounts[0];
  if (!from) throw new Error('No EVM account was authorised');
  if (from.toLowerCase() !== file.terms.userCounterAddress.toLowerCase()) {
    throw new Error('Use the Base wallet that created this lock');
  }
  const chainId = Number.parseInt(
    (await provider.request({ method: 'eth_chainId' })) as string,
    16,
  );
  if (chainId !== file.contracts.evm.chainId) {
    throw new Error(`Switch the wallet to chain ${file.contracts.evm.chainId}`);
  }
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from,
        to: file.contracts.evm.address,
        data: evmRefundCalldata(file),
        value: '0x0',
      },
    ],
  })) as string;
}
