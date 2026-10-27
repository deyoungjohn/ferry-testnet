import {
  SigningSerializationFlag,
  binToHex,
  encodeLockingBytecodeP2pkh,
  encodeTransaction,
  generateSigningSerializationBCH,
  hash160,
  secp256k1,
  sha256,
} from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  WalletSignedTransactionError,
  inspectSignedTransaction,
} from '../lib/wallet/signed-check';

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
  it('accepts a valid wallet SIGHASH_UTXOS signature', () => {
    const privateKey = new Uint8Array(32).fill(9);
    const pubkey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof pubkey === 'string') throw new Error(pubkey);
    const locking = encodeLockingBytecodeP2pkh(hash160(pubkey));
    const spendSource = {
      ...source[0]!,
      lockingBytecode: locking,
    };
    const unsigned = {
      version: 2 as const,
      locktime: 0,
      inputs: [
        {
          outpointTransactionHash: new Uint8Array(32).fill(1),
          outpointIndex: 0,
          sequenceNumber: 0xffffffff,
          unlockingBytecode: new Uint8Array(),
        },
      ],
      outputs: [{ lockingBytecode: locking, valueSatoshis: 1_000n }],
    };
    const hashType =
      SigningSerializationFlag.allOutputs |
      SigningSerializationFlag.utxos |
      SigningSerializationFlag.forkId;
    const preimage = generateSigningSerializationBCH(
      {
        inputIndex: 0,
        sourceOutputs: [spendSource],
        transaction: unsigned,
      },
      {
        coveredBytecode: locking,
        signingSerializationType: new Uint8Array([hashType]),
      },
    );
    const signature = secp256k1.signMessageHashSchnorr(
      privateKey,
      sha256.hash(sha256.hash(preimage)),
    );
    if (typeof signature === 'string') throw new Error(signature);
    const signed = {
      ...unsigned,
      inputs: [
        {
          ...unsigned.inputs[0]!,
          unlockingBytecode: Uint8Array.from([
            0x41,
            ...signature,
            hashType,
            0x21,
            ...pubkey,
          ]),
        },
      ],
    };
    const report = inspectSignedTransaction(
      binToHex(encodeTransaction(unsigned)),
      binToHex(encodeTransaction(signed)),
      [spendSource],
    );
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports an input that came back unsigned', () => {
    const unsigned = txHex(new Uint8Array());
    const report = inspectSignedTransaction(unsigned, unsigned, source);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('Input 0 came back unsigned');
    expect(report.failedInput).toBe(0);
    expect(report.diagnostic.inputs[0]?.signed).toBe(false);
    const error = new WalletSignedTransactionError(report);
    expect(error.message).toContain('Input 0 failed the local check');
    expect(error.diagnostic.unsignedHex).toBe(unsigned);
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
