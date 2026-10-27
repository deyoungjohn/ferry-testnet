import {
  binToHex,
  createVirtualMachineBCH,
  decodeTransaction,
  encodeTransactionOutput,
  hexToBin,
  type Output,
  type Transaction,
} from '@bitauth/libauth';
import type { BchSourceOutput } from './types';

export interface SignedTransactionReport {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

function decode(hex: string, label: string): Transaction | string {
  const decoded = decodeTransaction(hexToBin(hex.replace(/^0x/, '')));
  return typeof decoded === 'string'
    ? `${label} does not decode: ${decoded}`
    : decoded;
}

const outputHex = (output: Output): string =>
  binToHex(encodeTransactionOutput(output));

/**
 * A wallet answer is not trusted: it must keep the request's inputs and
 * outputs and every input must pass the script VM against its source output
 * (, T9). Returns the problems found; empty means safe to broadcast.
 */
export function inspectSignedTransaction(
  unsignedHex: string,
  signedHex: string,
  sourceOutputs: readonly BchSourceOutput[],
): SignedTransactionReport {
  const unsigned = decode(unsignedHex, 'The request transaction');
  const signed = decode(signedHex, 'The wallet transaction');
  if (typeof unsigned === 'string') return { ok: false, problems: [unsigned] };
  if (typeof signed === 'string') return { ok: false, problems: [signed] };

  const problems: string[] = [];
  if (signed.inputs.length !== unsigned.inputs.length) {
    problems.push(
      `The wallet returned ${signed.inputs.length} inputs; the request had ${unsigned.inputs.length}.`,
    );
  }
  unsigned.inputs.forEach((input, index) => {
    const returned = signed.inputs[index];
    if (!returned) return;
    if (
      binToHex(returned.outpointTransactionHash) !==
        binToHex(input.outpointTransactionHash) ||
      returned.outpointIndex !== input.outpointIndex
    ) {
      problems.push(
        `Input ${index} spends a different outpoint than requested.`,
      );
    }
  });
  if (signed.outputs.length !== unsigned.outputs.length) {
    problems.push(
      `The wallet returned ${signed.outputs.length} outputs; the request had ${unsigned.outputs.length}.`,
    );
  } else {
    unsigned.outputs.forEach((output, index) => {
      const returned = signed.outputs[index];
      if (returned && outputHex(returned) !== outputHex(output)) {
        problems.push(`Output ${index} was changed by the wallet.`);
      }
    });
  }
  signed.inputs.forEach((input, index) => {
    if (input.unlockingBytecode.length === 0) {
      problems.push(
        `Input ${index} came back unsigned (empty unlocking script).`,
      );
    }
  });

  if (problems.length === 0 && sourceOutputs.length === signed.inputs.length) {
    const vm = createVirtualMachineBCH();
    const result = vm.verify({
      sourceOutputs: sourceOutputs.map((output) => ({
        lockingBytecode: output.lockingBytecode,
        valueSatoshis: output.valueSatoshis,
        ...(output.token
          ? {
              token: {
                category: output.token.category,
                amount: output.token.amount,
              },
            }
          : {}),
      })),
      transaction: signed,
    });
    if (typeof result === 'string') {
      problems.push(`Script check failed: ${result}`);
    }
  }
  return { ok: problems.length === 0, problems };
}
