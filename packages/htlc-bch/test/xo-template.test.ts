import { describe, it, expect } from 'vitest';
import * as libauth from '@bitauth/libauth';
import { parseTemplate, compileCashAssemblyString } from '@xo-cash/utils';
import {
  ferryHtlcTemplate,
  getParsedFerryHtlcTemplate,
  serializeFerryHtlcTemplate,
} from '../xo/index.js';
import {
  encodeHtlcParameters,
  getHtlcContract,
  artifact,
  displayHexToInternalHex,
} from '../src/index.js';

describe('XO Template: ferry-htlc', () => {
  it('parses successfully with parseTemplate and passes schema validation', () => {
    const parsed = getParsedFerryHtlcTemplate();
    expect(parsed.name).toBe('Ferry HTLC');
    expect(parsed.actions.lock).toBeDefined();
    expect(parsed.actions.claim).toBeDefined();
    expect(parsed.actions.refund).toBeDefined();
    expect(parsed.lockingScripts.htlcLockingScript).toBeDefined();
  });

  it('serializes cleanly with serializeTemplate', () => {
    const serialized = serializeFerryHtlcTemplate();
    expect(typeof serialized).toBe('string');
    const reparsed = parseTemplate(serialized);
    expect(reparsed.name).toBe('Ferry HTLC');
  });

  it('S-02 / BCH-E-01: XO locking bytecode is byte-identical to CashScript artifact locking bytecode', () => {
    const secret = new Uint8Array(32).fill(0x01);
    const hashLock = libauth.sha256.hash(secret);
    const recipientBytecode = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x11),
      0x88,
      0xac,
    ]);
    const refundBytecode = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x22),
      0x88,
      0xac,
    ]);
    const displayCatHex =
      '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
    const internalCatHex = displayHexToInternalHex(displayCatHex);

    const params = encodeHtlcParameters({
      hashLock,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: displayCatHex,
      tokenAmount: 1000n,
      refundHeight: 500000,
      maxFee: 1500n,
    });

    const cashScriptContract = getHtlcContract(params);
    const cashScriptRedeemHex = cashScriptContract.bytecode;

    // Now compile via XO CashAssembly
    // Note: CashScript pushes constructor parameters in reverse order so that
    // on the stack, hashLock is on top and maxFee is at the bottom.
    // In CashScript's bytecode string, '20' represented hex 0x20 (32 in decimal).
    // In CashAssembly, literal decimal 32 is written as <32> (or <0x20>).
    const fixedBytecode = artifact.bytecode.replace(
      '20 OP_NUMEQUALVERIFY',
      '<32> OP_NUMEQUALVERIFY',
    );
    const xoScript =
      `<1500> <500000> <1000> <0x${internalCatHex}> <0x${libauth.binToHex(refundBytecode)}> <0x${libauth.binToHex(recipientBytecode)}> <0x${libauth.binToHex(hashLock)}> ` +
      fixedBytecode;
    const xoRedeemHex = compileCashAssemblyString({
      cashAssemblyText: xoScript,
      variables: {},
      evaluationDecodeMode: 'hex',
    });

    expect(xoRedeemHex).toBe(cashScriptRedeemHex);

    // Also compare P2SH32 locking bytecode: P2SH32 uses hash256 (sha256(sha256(script)))
    const cashScriptLockingHex = cashScriptContract.lockingBytecode;
    const xoRedeemBytes = libauth.hexToBin(xoRedeemHex);
    const xoHash256 = libauth.sha256.hash(libauth.sha256.hash(xoRedeemBytes));
    const xoP2sh32Bytecode = new Uint8Array([
      0xaa, // OP_HASH256
      0x20, // push 32 bytes
      ...xoHash256,
      0x87, // OP_EQUAL
    ]);
    const xoLockingHex = libauth.binToHex(xoP2sh32Bytecode);

    expect(xoLockingHex).toBe(cashScriptLockingHex);
  });

  it('compiles template htlcLockingBytecode directly using templateScripts mapping', () => {
    const secret = new Uint8Array(32).fill(0x01);
    const hashLock = libauth.sha256.hash(secret);
    const recipientBytecode = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x11),
      0x88,
      0xac,
    ]);
    const refundBytecode = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x22),
      0x88,
      0xac,
    ]);
    const displayCatHex =
      '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
    const internalCatBytes = libauth.hexToBin(
      displayHexToInternalHex(displayCatHex),
    );

    const variables = {
      hashLock,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: internalCatBytes,
      tokenAmount: 1000,
      refundHeight: 500000,
      maxFee: 1500,
    };

    const compiledHex = compileCashAssemblyString({
      cashAssemblyText: 'htlcLockingBytecode',
      variables,
      templateScripts: ferryHtlcTemplate.scripts,
      evaluationDecodeMode: 'hex',
    });

    const params = encodeHtlcParameters({
      hashLock,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: displayCatHex,
      tokenAmount: 1000n,
      refundHeight: 500000,
      maxFee: 1500n,
    });
    const cashScriptContract = getHtlcContract(params);
    expect(compiledHex).toBe(cashScriptContract.bytecode);
  });
});
