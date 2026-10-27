import {
  binToHex,
  decodePrivateKeyWif,
  decodeTransaction,
  encodeLockingBytecodeP2pkh,
  hash160,
  hexToBin,
  lockingBytecodeToCashAddress,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import { parseExtendedJson, toUint8Array } from '@wizardconnect/core';
import {
  MockNetworkProvider,
  Network,
  SignatureTemplate,
  TransactionBuilder,
} from 'cashscript';
import type { Page } from '@playwright/test';
import { FulcrumClient } from '../../../htlc-bch/src/electrum';

export interface ScriptWalletUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly satoshis: string;
  readonly lockingBytecode: string;
  readonly token?: {
    readonly category: string;
    readonly amount: string;
  };
}

export interface ScriptWalletSignRequest {
  readonly transaction: string;
  readonly sourceOutputs: readonly unknown[];
  readonly broadcast: boolean;
  readonly userPrompt: string;
}

export interface ScriptWalletSignResponse {
  readonly signedTransaction: string;
  readonly signedTransactionHash: string;
}

interface BchSignerDetails {
  readonly privateKey: Uint8Array;
  readonly address: string;
  readonly lockingBytecodeHex: string;
  readonly scriptHash: string;
}

interface RelaySourceOutput {
  readonly outpointIndex: number;
  readonly outpointTransactionHash: Uint8Array;
  readonly sequenceNumber: number;
  readonly unlockingBytecode: Uint8Array;
  readonly valueSatoshis: bigint;
  readonly lockingBytecode: Uint8Array;
  readonly token?: {
    readonly category: Uint8Array;
    readonly amount: bigint;
  };
}

interface ParsedSignRequest {
  readonly transaction: string;
  readonly sourceOutputs: readonly unknown[];
  readonly broadcast: boolean;
  readonly userPrompt: string;
}

function deriveSigner(wif: string): BchSignerDetails {
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('Invalid USER_BCH_WIF');
  const pubkey = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pubkey === 'string') throw new Error(pubkey);
  const locking = encodeLockingBytecodeP2pkh(hash160(pubkey));
  const encoded = lockingBytecodeToCashAddress({
    bytecode: locking,
    prefix: 'bchtest',
    tokenSupport: true,
  });
  if (typeof encoded === 'string') throw new Error(encoded);
  const scriptHashBytes = sha256.hash(locking);
  scriptHashBytes.reverse();
  return {
    privateKey: decoded.privateKey,
    address: encoded.address,
    lockingBytecodeHex: `0x${binToHex(locking)}`,
    scriptHash: binToHex(scriptHashBytes),
  };
}

function txidOf(txHex: string): string {
  const hash = sha256.hash(sha256.hash(hexToBin(txHex)));
  hash.reverse();
  return binToHex(hash);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' || typeof value === 'string') {
    return BigInt(value);
  }
  throw new Error('Relay request contained a non-numeric satoshi value');
}

function parseSourceOutput(value: unknown): RelaySourceOutput {
  const record = value as Record<string, unknown>;
  const token = record.token as Record<string, unknown> | undefined;
  return {
    outpointIndex: Number(record.outpointIndex),
    outpointTransactionHash: toUint8Array(
      String(record.outpointTransactionHash),
    ),
    sequenceNumber: Number(record.sequenceNumber),
    unlockingBytecode: toUint8Array(String(record.unlockingBytecode)),
    valueSatoshis: toBigInt(record.valueSatoshis),
    lockingBytecode: toUint8Array(String(record.lockingBytecode)),
    ...(token
      ? {
          token: {
            category: toUint8Array(String(token.category)),
            amount: toBigInt(token.amount),
          },
        }
      : {}),
  };
}

export class ScriptBchWallet {
  readonly address: string;
  readonly #privateKey: Uint8Array;
  readonly #details: BchSignerDetails;
  readonly #fulcrum: FulcrumClient;
  readonly #signRequests: ScriptWalletSignRequest[] = [];
  readonly #broadcasts: string[] = [];

  constructor(wif: string, fulcrumUrl: string) {
    this.#details = deriveSigner(wif);
    this.#privateKey = this.#details.privateKey;
    this.address = this.#details.address;
    this.#fulcrum = new FulcrumClient(fulcrumUrl);
  }

  async connect(): Promise<void> {
    await this.#fulcrum.connect();
  }

  close(): void {
    this.#fulcrum.close();
  }

  get signRequests(): readonly ScriptWalletSignRequest[] {
    return this.#signRequests;
  }

  get broadcasts(): readonly string[] {
    return this.#broadcasts;
  }

  async listUtxos(): Promise<readonly ScriptWalletUtxo[]> {
    const utxos = await this.#fulcrum.listUnspent(
      this.#details.scriptHash,
      'include_tokens',
    );
    return utxos.map((utxo) => ({
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: String(utxo.value),
      lockingBytecode: this.#details.lockingBytecodeHex,
      ...(utxo.token_data
        ? {
            token: {
              category: utxo.token_data.category,
              amount: String(utxo.token_data.amount),
            },
          }
        : {}),
    }));
  }

  async sign(
    request: ScriptWalletSignRequest,
  ): Promise<ScriptWalletSignResponse> {
    this.#signRequests.push(request);
    const parsed = parseExtendedJson(
      JSON.stringify(request),
    ) as ParsedSignRequest;
    if (parsed.broadcast !== false) {
      throw new Error('The live proof only signs with broadcast:false');
    }
    const unsigned = decodeTransaction(hexToBin(parsed.transaction));
    if (typeof unsigned === 'string') throw new Error(unsigned);
    if (parsed.sourceOutputs.length !== unsigned.inputs.length) {
      throw new Error('Source output count does not match the transaction');
    }

    const provider = new MockNetworkProvider();
    provider.network = Network.CHIPNET;
    const template = new SignatureTemplate(this.#privateKey);
    const builder = new TransactionBuilder({ provider });
    for (const raw of parsed.sourceOutputs) {
      const source = parseSourceOutput(raw);
      const unlocker = template.unlockP2PKH();
      builder.addInput(
        {
          txid: binToHex(source.outpointTransactionHash),
          vout: source.outpointIndex,
          satoshis: source.valueSatoshis,
          lockingBytecode: binToHex(source.lockingBytecode),
          ...(source.token
            ? {
                token: {
                  category: binToHex(source.token.category),
                  amount: source.token.amount,
                },
              }
            : {}),
        },
        unlocker,
      );
    }
    for (const output of unsigned.outputs) {
      builder.addOutput({
        to: output.lockingBytecode,
        amount: output.valueSatoshis,
        ...(output.token
          ? {
              token: {
                category: binToHex(output.token.category),
                amount: output.token.amount,
              },
            }
          : {}),
      });
    }
    const signedTransaction = builder.build();
    return {
      signedTransaction,
      signedTransactionHash: txidOf(signedTransaction),
    };
  }

  async broadcast(txHex: string): Promise<string> {
    const txid = await this.#fulcrum.broadcast(txHex);
    this.#broadcasts.push(txid);
    return txid;
  }

  async attach(page: Page): Promise<void> {
    await page.exposeFunction('__ferryScriptWalletList', () =>
      this.listUtxos(),
    );
    await page.exposeFunction(
      '__ferryScriptWalletSign',
      (request: ScriptWalletSignRequest) => this.sign(request),
    );
    await page.exposeFunction('__ferryScriptWalletBroadcast', (txHex: string) =>
      this.broadcast(txHex),
    );
    await page.addInitScript(
      ({ address }) => {
        const target = window as unknown as {
          __ferryScriptWallet?: unknown;
          __ferryScriptWalletList: () => Promise<unknown>;
          __ferryScriptWalletSign: (request: unknown) => Promise<unknown>;
          __ferryScriptWalletBroadcast: (txHex: string) => Promise<unknown>;
        };
        target.__ferryScriptWallet = {
          address,
          listUtxos: () => target.__ferryScriptWalletList(),
          sign: (request: unknown) => target.__ferryScriptWalletSign(request),
          broadcast: (txHex: string) =>
            target.__ferryScriptWalletBroadcast(txHex),
        };
      },
      { address: this.address },
    );
  }
}
