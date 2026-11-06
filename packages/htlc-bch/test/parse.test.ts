import { hexToBin, sha256, decodeTransactionBCH } from '@bitauth/libauth';
import { describe, expect, it } from 'vitest';
import {
  buildClaimTransaction,
  buildRefundTransaction,
  deriveHtlcAddresses,
  parseHtlcRedeemScript,
  parseHtlcSpendInput,
  type BchHtlcParameters,
} from '../src/index.js';

function params(over: Partial<BchHtlcParameters> = {}): BchHtlcParameters {
  const secret = new Uint8Array(32).fill(7);
  return {
    hashLock: sha256.hash(secret),
    recipientLockingBytecode: hexToBin(`76a914${'11'.repeat(20)}88ac`),
    refundLockingBytecode: hexToBin(`76a914${'22'.repeat(20)}88ac`),
    tokenCategory: hexToBin('33'.repeat(32)),
    tokenAmount: 3700n,
    refundHeight: 330_195,
    maxFee: 1500n,
    ...over,
  };
}

describe('parseHtlcRedeemScript', () => {
  it('reads back the parameters it was built from', () => {
    const p = params();
    const redeem = deriveHtlcAddresses(p, 'chipnet').redeemScript;
    const parsed = parseHtlcRedeemScript(redeem);
    expect(parsed?.tokenAmount).toBe(3700n);
    expect(parsed?.refundHeight).toBe(330_195);
    expect(parsed?.maxFee).toBe(1500n);
    expect(parsed?.hashLock).toEqual(p.hashLock);
    expect(parsed?.recipientLockingBytecode).toEqual(
      p.recipientLockingBytecode,
    );
  });

  it('handles tiny numbers that script encodes as single opcodes', () => {
    for (const tokenAmount of [1n, 16n, 17n, 127n, 128n, 255n, 65_535n]) {
      const redeem = deriveHtlcAddresses(params({ tokenAmount })).redeemScript;
      expect(parseHtlcRedeemScript(redeem)?.tokenAmount).toBe(tokenAmount);
    }
    const low = deriveHtlcAddresses(params({ refundHeight: 5 })).redeemScript;
    expect(parseHtlcRedeemScript(low)?.refundHeight).toBe(5);
  });

  it('rejects scripts that are not this covenant', () => {
    expect(
      parseHtlcRedeemScript(hexToBin('76a914' + '00'.repeat(20) + '88ac')),
    ).toBeNull();
    const redeem = deriveHtlcAddresses(params()).redeemScript.slice();
    redeem[redeem.length - 3] = (redeem[redeem.length - 3]! + 1) & 0xff;
    expect(parseHtlcRedeemScript(redeem)).toBeNull();
  });
});

describe('parseHtlcSpendInput', () => {
  const secret = new Uint8Array(32).fill(7);
  const p = params();
  const utxo = { txid: 'ab'.repeat(32), vout: 0, satoshis: 10_000n };

  it('recognises a claim and reveals the secret', () => {
    const built = buildClaimTransaction({
      params: p,
      network: 'chipnet',
      secret,
      utxo,
      feeSats: 500n,
    });
    const tx = decodeTransactionBCH(hexToBin(built.txHex));
    if (typeof tx === 'string') throw new Error(tx);
    const info = parseHtlcSpendInput(tx.inputs[0]!.unlockingBytecode);
    expect(info?.path).toBe('claim');
    expect(info?.secret).toEqual(secret);
    expect(info?.lockingBytecode).toEqual(
      deriveHtlcAddresses(p).lockingBytecode,
    );
  });

  it('recognises a refund', () => {
    const built = buildRefundTransaction({
      params: p,
      network: 'chipnet',
      utxo,
      feeSats: 500n,
    });
    const tx = decodeTransactionBCH(hexToBin(built.txHex));
    if (typeof tx === 'string') throw new Error(tx);
    const info = parseHtlcSpendInput(tx.inputs[0]!.unlockingBytecode);
    expect(info?.path).toBe('refund');
    expect(info?.secret).toBeNull();
    expect(info?.params.refundHeight).toBe(330_195);
  });
});
