import { describe, it, expect } from 'vitest';
import {
  displayToInternalCategory,
  encodeHtlcParameters,
  buildClaimTransaction,
} from '@ferry/htlc-bch';
import { decodeTransaction } from '@bitauth/libauth';
import { sha256 } from 'viem';
import { extractSecretFromClaimUnlock } from '../src/bch/lock-builder.js';

describe('BCH Lock and Secret Extraction', () => {
  it('extracts secret from user BCH claim transaction unlocking bytecode', () => {
    const secret =
      '0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff' as const;
    const hashLock = sha256(secret);

    const bchParams = encodeHtlcParameters({
      recipientLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      refundLockingBytecode:
        '0x76a914222222222222222222222222222222222222222288ac',
      hashLock,
      refundHeight: 330000,
      tokenCategory: displayToInternalCategory(
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
      ),
      tokenAmount: 1000n,
      maxFee: 1500n,
    });

    const claimTxResult = buildClaimTransaction({
      params: bchParams,
      utxo: {
        txid: '33'.repeat(32),
        vout: 0,
        satoshis: 3000n,
      },
      secret,
    });

    const decoded = decodeTransaction(Buffer.from(claimTxResult.txHex, 'hex'));
    if (typeof decoded === 'string') {
      throw new Error(decoded);
    }

    const input0 = decoded.inputs[0];
    if (!input0) throw new Error('Missing input 0');
    const unlocking = input0.unlockingBytecode;
    const extractedSecret = extractSecretFromClaimUnlock(unlocking, hashLock);

    expect(extractedSecret).toBe(secret);
  });

  it('fails to extract secret if hashLock does not match', () => {
    const secret =
      '0x11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff' as const;
    const wrongHashLock =
      '0x9999999999999999999999999999999999999999999999999999999999999999';

    const bchParams = encodeHtlcParameters({
      recipientLockingBytecode:
        '0x76a914111111111111111111111111111111111111111188ac',
      refundLockingBytecode:
        '0x76a914222222222222222222222222222222222222222288ac',
      hashLock: sha256(secret),
      refundHeight: 330000,
      tokenCategory: displayToInternalCategory(
        '0xec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
      ),
      tokenAmount: 1000n,
      maxFee: 1500n,
    });

    const claimTxResult = buildClaimTransaction({
      params: bchParams,
      utxo: {
        txid: '33'.repeat(32),
        vout: 0,
        satoshis: 3000n,
      },
      secret,
    });

    const decoded = decodeTransaction(Buffer.from(claimTxResult.txHex, 'hex'));
    if (typeof decoded === 'string') {
      throw new Error(decoded);
    }

    const input0 = decoded.inputs[0];
    if (!input0) throw new Error('Missing input 0');
    const unlocking = input0.unlockingBytecode;
    const extractedSecret = extractSecretFromClaimUnlock(
      unlocking,
      wrongHashLock,
    );
    expect(extractedSecret).toBeNull();
  });
});
