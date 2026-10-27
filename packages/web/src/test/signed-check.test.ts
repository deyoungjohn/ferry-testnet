import { binToHex, encodeTransaction } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import { inspectSignedTransaction } from '../lib/wallet/signed-check';

const lockingBytecode = Uint8Array.from([
  0x76,
  0xa9,
  0x14,
  ...new Array<number>(20).fill(7),
  0x88,
  0xac,
]);

function txHex(unlockingBytecode: Uint8Array, valueSatoshis = 1_000n): string {
  return binToHex(
    encodeTransaction({
      version: 2,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32).fill(1),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode,
        },
      ],
      outputs: [{ lockingBytecode, valueSatoshis }],
    }),
  );
}

const source = [
  {
    outpointIndex: 0,
    outpointTransactionHash: new Uint8Array(32).fill(1),
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
    valueSatoshis: 2_000n,
    lockingBytecode,
  },
];

describe('wallet-signed transaction check', () => {
  it('reports an input that came back unsigned', () => {
    const unsigned = txHex(new Uint8Array());
    const report = inspectSignedTransaction(unsigned, unsigned, source);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('Input 0 came back unsigned');
  });

  it('reports an output changed by the wallet', () => {
    const report = inspectSignedTransaction(
      txHex(new Uint8Array()),
      txHex(Uint8Array.from([0x00]), 999n),
      source,
    );
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('Output 0 was changed');
  });

  it('reports a script that fails the VM', () => {
    const report = inspectSignedTransaction(
      txHex(new Uint8Array()),
      txHex(Uint8Array.from([0x01, 0x02])),
      source,
    );
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('Script check failed');
  });
});
