import { describe, expect, it } from 'vitest';
import {
  buildInputPaths,
  sourceOutputToRelay,
} from '../lib/wallet/relay-format';

describe('WizardConnect relay wire format', () => {
  it('serializes bigint and bytes without throwing', () => {
    const wire = sourceOutputToRelay({
      outpointIndex: 1,
      outpointTransactionHash: Uint8Array.from([0xab, 0x01]),
      sequenceNumber: 0xffffffff,
      unlockingBytecode: new Uint8Array(),
      valueSatoshis: 5_000n,
      lockingBytecode: Uint8Array.from([0x76, 0xa9]),
      token: { category: Uint8Array.from([0xec, 0x33]), amount: 2_500n },
    });
    const json = JSON.stringify({ sourceOutputs: [wire] });
    expect(JSON.parse(json).sourceOutputs[0]).toEqual({
      outpointTransactionHash: 'ab01',
      outpointIndex: 1,
      unlockingBytecode: '',
      sequenceNumber: 0xffffffff,
      valueSatoshis: '<bigint: 5000n>',
      lockingBytecode: '76a9',
      token: { category: 'ec33', amount: '<bigint: 2500n>' },
    });
  });

  it('omits the token when the output has none', () => {
    const wire = sourceOutputToRelay({
      outpointIndex: 0,
      outpointTransactionHash: new Uint8Array(32),
      sequenceNumber: 0,
      unlockingBytecode: new Uint8Array(),
      valueSatoshis: 1n,
      lockingBytecode: new Uint8Array(),
    }) as Record<string, unknown>;
    expect('token' in wire).toBe(false);
  });
});

describe('inputPaths', () => {
  const out = (bytes: number[]) => ({
    outpointIndex: 0,
    outpointTransactionHash: new Uint8Array(32),
    sequenceNumber: 0,
    unlockingBytecode: new Uint8Array(),
    valueSatoshis: 1n,
    lockingBytecode: Uint8Array.from(bytes),
  });

  it('uses the input position as the first element, even on one address', () => {
    expect(
      buildInputPaths([out([1]), out([1]), out([2])], '0x01', '0x02'),
    ).toEqual([
      [0, 'receive', 0],
      [1, 'receive', 0],
      [2, 'change', 0],
    ]);
  });

  it('refuses an input that is not the wallet receive or change address', () => {
    expect(() => buildInputPaths([out([9])], '0x01', '0x02')).toThrow(
      /does not belong/,
    );
  });
});
