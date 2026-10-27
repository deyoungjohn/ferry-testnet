import { parseExtendedJson, toBigInt, toUint8Array } from '@wizardconnect/core';
import { describe, expect, it } from 'vitest';
import type { BchAddressInfo } from '../lib/bch/address';
import {
  buildInputPaths,
  sourceOutputToRelay,
} from '../lib/wallet/relay-format';
import type { BchSourceOutput } from '../lib/wallet/types';

const receive: BchAddressInfo = {
  address: 'bchtest:zqreceive',
  lockingBytecode: '0x76a914111111111111111111111111111111111111111188ac',
  tokenAware: true,
};
const change: BchAddressInfo = {
  address: 'bchtest:zqchange',
  lockingBytecode: '0x76a914222222222222222222222222222222222222222288ac',
  tokenAware: true,
};

const sourceOutputs: readonly BchSourceOutput[] = [
  {
    outpointIndex: 0,
    outpointTransactionHash: new Uint8Array(32).fill(0xaa),
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
    valueSatoshis: 5_000n,
    lockingBytecode: Uint8Array.from(
      Buffer.from(receive.lockingBytecode.slice(2), 'hex'),
    ),
    token: {
      category: Uint8Array.from(new Array<number>(32).fill(0xec)),
      amount: 250n,
    },
  },
  {
    outpointIndex: 1,
    outpointTransactionHash: new Uint8Array(32).fill(0xbb),
    sequenceNumber: 0xffffffff,
    unlockingBytecode: new Uint8Array(),
    valueSatoshis: 1_000n,
    lockingBytecode: Uint8Array.from(
      Buffer.from(change.lockingBytecode.slice(2), 'hex'),
    ),
  },
];

describe('real-wallet signing request shape', () => {
  it('gives every input its own input index', () => {
    const paths = buildInputPaths(
      sourceOutputs,
      receive.lockingBytecode,
      change.lockingBytecode,
    );
    expect(paths).toEqual([
      [0, 'receive', 0],
      [1, 'change', 0],
    ]);
  });

  it('round-trips through the wallet-side extended JSON parser', () => {
    const request = {
      transaction: {
        transaction: '00',
        sourceOutputs: sourceOutputs.map(sourceOutputToRelay),
        broadcast: false,
        userPrompt: 'Lock tPUSD',
      },
      inputPaths: buildInputPaths(
        sourceOutputs,
        receive.lockingBytecode,
        change.lockingBytecode,
      ),
    };
    const parsed = parseExtendedJson(JSON.stringify(request)) as {
      readonly inputPaths: readonly [number, string, number][];
      readonly transaction: {
        readonly sourceOutputs: readonly [
          {
            readonly valueSatoshis: bigint;
            readonly outpointTransactionHash: string;
            readonly lockingBytecode: string;
            readonly token?: {
              readonly category: string;
              readonly amount: bigint;
            };
          },
          {
            readonly valueSatoshis: bigint;
            readonly outpointTransactionHash: string;
            readonly lockingBytecode: string;
          },
        ];
      };
    };
    expect(parsed.inputPaths).toEqual([
      [0, 'receive', 0],
      [1, 'change', 0],
    ]);
    expect(parsed.transaction.sourceOutputs[0]?.valueSatoshis).toBe(5_000n);
    expect(parsed.transaction.sourceOutputs[0]?.token?.amount).toBe(250n);
    expect(
      Array.from(
        toUint8Array(
          parsed.transaction.sourceOutputs[1]?.outpointTransactionHash ?? '',
        ),
      ),
    ).toEqual(Array.from(new Uint8Array(32).fill(0xbb)));
    expect(toBigInt(parsed.transaction.sourceOutputs[1]?.valueSatoshis)).toBe(
      1_000n,
    );
    expect(parsed.transaction.sourceOutputs[1]?.lockingBytecode).toBe(
      change.lockingBytecode.slice(2),
    );
  });

  it('refuses an input that is not from the wallet receive or change path', () => {
    expect(() =>
      buildInputPaths(
        [
          {
            ...sourceOutputs[0]!,
            lockingBytecode: new Uint8Array(25).fill(3),
          },
        ],
        receive.lockingBytecode,
        change.lockingBytecode,
      ),
    ).toThrow(/receive or change path/);
  });
});
