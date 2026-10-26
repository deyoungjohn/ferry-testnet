import type { BchSourceOutput } from './types';

type SourceOutput = BchSourceOutput;

function toHex(bytes: Uint8Array | string): string {
  if (typeof bytes === 'string') return bytes.replace(/^0x/, '');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * WizardConnect relays the sign request as JSON, which cannot carry bigint or
 * Uint8Array. This mirrors the library's own wire format (`sourceOutputToRelay`
 * in @wizardconnect/core, not exported from its index): bytes as hex strings,
 * bigint as the string `<bigint: 123n>`.
 */
export function sourceOutputToRelay(output: SourceOutput): unknown {
  return {
    outpointTransactionHash: toHex(output.outpointTransactionHash),
    outpointIndex: output.outpointIndex,
    unlockingBytecode: toHex(output.unlockingBytecode),
    sequenceNumber: output.sequenceNumber,
    valueSatoshis: `<bigint: ${output.valueSatoshis}n>`,
    lockingBytecode: toHex(output.lockingBytecode),
    ...(output.token
      ? {
          token: {
            category: toHex(output.token.category),
            amount: `<bigint: ${output.token.amount}n>`,
          },
        }
      : {}),
  };
}
