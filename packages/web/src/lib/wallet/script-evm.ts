export interface ScriptEvmBridge {
  readonly address: string;
  readPermitNonce(): Promise<string>;
  signTypedData(typedDataWire: string): Promise<string>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function getScriptEvmBridge(
  value: unknown = globalThis.window,
): ScriptEvmBridge | null {
  const record = asRecord(value);
  const bridge = asRecord(record?.__ferryScriptEvm);
  if (!bridge) return null;
  const readNonce = bridge.readPermitNonce;
  const signTypedData = bridge.signTypedData;
  if (
    typeof bridge.address !== 'string' ||
    typeof readNonce !== 'function' ||
    typeof signTypedData !== 'function'
  ) {
    return null;
  }
  return {
    address: bridge.address,
    readPermitNonce: () =>
      Reflect.apply(readNonce, value, []) as Promise<string>,
    signTypedData: (typedDataWire) =>
      Reflect.apply(signTypedData, value, [typedDataWire]) as Promise<string>,
  };
}
