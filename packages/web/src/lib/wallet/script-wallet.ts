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

export interface ScriptWalletBridge {
  readonly address: string;
  listUtxos(): Promise<readonly ScriptWalletUtxo[]>;
  sign(
    request: ScriptWalletSignRequest,
  ): Promise<ScriptWalletSignResponse | null>;
  broadcast(txHex: string): Promise<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function getScriptWalletBridge(
  value: unknown = globalThis.window,
): ScriptWalletBridge | null {
  const record = asRecord(value);
  const bridge = asRecord(record?.__ferryScriptWallet);
  if (!bridge) return null;
  const listUtxos = bridge.listUtxos;
  const sign = bridge.sign;
  const broadcast = bridge.broadcast;
  if (
    typeof bridge.address !== 'string' ||
    typeof listUtxos !== 'function' ||
    typeof sign !== 'function' ||
    typeof broadcast !== 'function'
  ) {
    return null;
  }
  return {
    address: bridge.address,
    listUtxos: () =>
      Reflect.apply(listUtxos, value, []) as Promise<
        readonly ScriptWalletUtxo[]
      >,
    sign: (request) =>
      Reflect.apply(sign, value, [
        request,
      ]) as Promise<ScriptWalletSignResponse | null>,
    broadcast: (txHex) =>
      Reflect.apply(broadcast, value, [txHex]) as Promise<string>,
  };
}
