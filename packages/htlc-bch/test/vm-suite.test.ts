import { describe, it, expect } from 'vitest';
import * as libauth from '@bitauth/libauth';
import { TransactionBuilder, MockNetworkProvider, Network } from 'cashscript';
import {
  encodeHtlcParameters,
  getHtlcContract,
  deriveHtlcAddresses,
  buildClaimTransaction,
  buildRefundTransaction,
  displayHexToInternalHex,
  internalHexToDisplayHex,
  displayToInternalCategory,
  internalToDisplayCategory,
} from '../src/index.js';

interface TransactionBuilderWithLibauth {
  buildLibauthTransaction(): unknown;
}

describe('BCH HTLC Libauth VM Test Suite (BCH-U-01...13)', () => {
  // Consensus VM: Libauth 3.0.0 createVirtualMachineBCH() (BCH2023 / May 2023 consensus including CashTokens)
  const vm = libauth.createVirtualMachineBCH();

  function createMockProvider(): MockNetworkProvider {
    const p = new MockNetworkProvider();
    p.network = Network.CHIPNET;
    return p;
  }

  function buildLibTx(builder: TransactionBuilder): unknown {
    return (
      builder as unknown as TransactionBuilderWithLibauth
    ).buildLibauthTransaction();
  }

  function verifyVm(
    vmInstance: ReturnType<typeof libauth.createVirtualMachineBCH>,
    transaction: unknown,
    sourceOutputs: unknown[],
  ): string | true {
    type VerifyParams = Parameters<typeof vmInstance.verify>[0];
    return vmInstance.verify({
      transaction: transaction as VerifyParams['transaction'],
      sourceOutputs: sourceOutputs as VerifyParams['sourceOutputs'],
    });
  }

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
  const otherBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...new Uint8Array(20).fill(0x99),
    0x88,
    0xac,
  ]);

  // XV-004 category (PUSD mainnet) in display order:
  const displayCatHex =
    '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';

  const defaultParams = encodeHtlcParameters({
    hashLock,
    recipientLockingBytecode: recipientBytecode,
    refundLockingBytecode: refundBytecode,
    tokenCategory: displayCatHex,
    tokenAmount: 1000n,
    refundHeight: 500000,
    maxFee: 1500n,
  });

  const defaultUtxo = {
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    vout: 0,
    satoshis: 3000n,
  };

  it('BCH-U-01: Claim with correct 32-byte secret, correct output -> Accept', () => {
    const claimTx = buildClaimTransaction({
      params: defaultParams,
      utxo: defaultUtxo,
      secret,
      feeSats: 500n,
    });

    const res = verifyVm(vm, claimTx.libauthTx, [claimTx.sourceOutput]);
    expect(res).toBe(true);
  });

  it('BCH-U-02: Claim with wrong secret -> Reject', () => {
    const wrongSecret = new Uint8Array(32).fill(0x02);
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract.unlock.claim(wrongSecret));
    b.addOutput({
      to: recipientBytecode,
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-03: Claim with a 33-byte secret whose sha256 matches a crafted lock -> Reject (length)', () => {
    const secret33 = new Uint8Array(33).fill(0x01);
    const hashLock33 = libauth.sha256.hash(secret33);

    const params33 = encodeHtlcParameters({
      hashLock: hashLock33,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: displayCatHex,
      tokenAmount: 1000n,
      refundHeight: 500000,
      maxFee: 1500n,
    });

    const contract33 = getHtlcContract(params33);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract33.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract33.unlock.claim(secret33));
    b.addOutput({
      to: recipientBytecode,
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract33.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-03b / T4: Claim with a 31-byte secret whose sha256 matches a crafted lock -> Reject (length)', () => {
    const secret31 = new Uint8Array(31).fill(0x01);
    const hashLock31 = libauth.sha256.hash(secret31);

    const params31 = encodeHtlcParameters({
      hashLock: hashLock31,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: displayCatHex,
      tokenAmount: 1000n,
      refundHeight: 500000,
      maxFee: 1500n,
    });

    const contract31 = getHtlcContract(params31);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract31.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract31.unlock.claim(secret31));
    b.addOutput({
      to: recipientBytecode,
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract31.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-04: Claim to a different locking bytecode -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract.unlock.claim(secret));
    b.addOutput({
      to: otherBytecode, // Mismatched recipient
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-05: Claim with tokenAmount - 1 to recipient (+1 elsewhere) -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    // Split spend: output 0 has amount 999, output 1 has amount 1
    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract.unlock.claim(secret));
    b.addOutput({
      to: recipientBytecode,
      amount: 1500n,
      token: { category: displayCatHex, amount: 999n },
    });
    b.addOutput({
      to: otherBytecode,
      amount: 1000n,
      token: { category: displayCatHex, amount: 1n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-06: Claim burning more than maxFee -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    // Carry is 3000 sats, maxFee is 1500 sats.
    // Setting output value to 1499 sats burns 1501 sats fee (> maxFee).
    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract.unlock.claim(secret));
    b.addOutput({
      to: recipientBytecode,
      amount: 1499n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain(
      'Unsuccessful evaluation: completed with a non-truthy value on top of the stack',
    );
  });

  it('BCH-U-07: Category byte-order mismatch -> Reject', () => {
    // If the contract is created with display hex directly (treating it as internal hex),
    // the bytecode holds display hex. When the real token is spent on-chain, OP_OUTPUTTOKENCATEGORY
    // returns internal hex, causing an equality mismatch.
    const buggyParams = encodeHtlcParameters({
      hashLock,
      recipientLockingBytecode: recipientBytecode,
      refundLockingBytecode: refundBytecode,
      tokenCategory: displayCatHex,
      tokenCategoryIsInternal: true, // Error: forcing display hex as internal
      tokenAmount: 1000n,
      refundHeight: 500000,
      maxFee: 1500n,
    });

    const buggyContract = getHtlcContract(buggyParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: buggyContract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, buggyContract.unlock.claim(secret));
    b.addOutput({
      to: recipientBytecode,
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(buggyContract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-08: Refund with nLockTime < refundHeight -> Reject', () => {
    const refundTx = buildRefundTransaction({
      params: defaultParams,
      utxo: defaultUtxo,
      feeSats: 500n,
    });

    // Artificially mutate locktime below refundHeight
    const earlyTx = {
      ...(refundTx.libauthTx as Record<string, unknown>),
      locktime: 499999,
    };

    const res = verifyVm(vm, earlyTx, [refundTx.sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain(
      'OP_CHECKLOCKTIMEVERIFY operation that requires a locktime greater than the transaction',
    );
  });

  it('BCH-U-09: Refund with nLockTime >= refundHeight, correct payee -> Accept', () => {
    const refundTx = buildRefundTransaction({
      params: defaultParams,
      utxo: defaultUtxo,
      feeSats: 500n,
    });

    const res = verifyVm(vm, refundTx.libauthTx, [refundTx.sourceOutput]);
    expect(res).toBe(true);
  });

  it('BCH-U-10: Refund to the claim recipient -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxoObj = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxoObj, contract.unlock.refund(), { sequence: 0xfffffffe });
    b.setLocktime(500000);
    b.addOutput({
      to: recipientBytecode, // Mismatched refund destination
      amount: 2500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-11: Claim after refundHeight -> Accept (documented race, §4.2)', () => {
    const claimTx = buildClaimTransaction({
      params: defaultParams,
      utxo: defaultUtxo,
      secret,
      feeSats: 500n,
    });

    // Set locktime far past refundHeight: claim branch does not inspect locktime
    const lateTx = {
      ...(claimTx.libauthTx as Record<string, unknown>),
      locktime: 600000,
    };

    const res = verifyVm(vm, lateTx, [claimTx.sourceOutput]);
    expect(res).toBe(true);
  });

  it('BCH-U-12: Extra input added (fee bump attempt) -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxo1 = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: { category: displayCatHex, amount: 1000n },
    };
    const utxo2 = {
      txid: '0000000000000000000000000000000000000000000000000000000000000002',
      vout: 0,
      satoshis: 1000n,
      lockingBytecode: libauth.binToHex(recipientBytecode),
    };

    const dummyUnlocker = {
      generateUnlockingBytecode: () => new Uint8Array(),
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxo1, contract.unlock.claim(secret));
    b.addInput(utxo2, dummyUnlocker);
    b.addOutput({
      to: recipientBytecode,
      amount: 3500n,
      token: { category: displayCatHex, amount: 1000n },
    });

    const libTx = buildLibTx(b);
    const sourceOutput1 = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: { category: libauth.hexToBin(displayCatHex), amount: 1000n },
    };
    const sourceOutput2 = {
      lockingBytecode: recipientBytecode,
      valueSatoshis: 1000n,
    };

    const res = verifyVm(vm, libTx, [sourceOutput1, sourceOutput2]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  it('BCH-U-13: NFT or capability token in place of the fungible token -> Reject', () => {
    const contract = getHtlcContract(defaultParams);
    const provider = createMockProvider();

    const utxo = {
      txid: defaultUtxo.txid,
      vout: defaultUtxo.vout,
      satoshis: 3000n,
      lockingBytecode: contract.lockingBytecode,
      token: {
        category: displayCatHex,
        amount: 1000n,
        nft: { capability: 'mutable' as const, commitment: '1122' },
      },
    };

    const b = new TransactionBuilder({ provider });
    b.addInput(utxo, contract.unlock.claim(secret));
    b.addOutput({
      to: recipientBytecode,
      amount: 2500n,
      token: {
        category: displayCatHex,
        amount: 1000n,
        nft: { capability: 'mutable' as const, commitment: '1122' },
      },
    });

    const libTx = buildLibTx(b);
    const sourceOutput = {
      lockingBytecode: libauth.hexToBin(contract.lockingBytecode),
      valueSatoshis: 3000n,
      token: {
        category: libauth.hexToBin(displayCatHex),
        amount: 1000n,
        nft: {
          capability: 'mutable' as const,
          commitment: libauth.hexToBin('1122'),
        },
      },
    };

    const res = verifyVm(vm, libTx, [sourceOutput]);
    expect(typeof res).toBe('string');
    expect(res).toContain('Program failed an OP_VERIFY operation');
  });

  describe('Cross-check vectors & helpers', () => {
    it('XV-001: Independent secret hash and claim evaluation', () => {
      // 32 bytes of 0x01
      const xv001Secret = new Uint8Array(32).fill(0x01);
      const computedHash = libauth.binToHex(libauth.sha256.hash(xv001Secret));
      const expectedHash =
        '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793';
      expect(computedHash).toBe(expectedHash);

      // Evaluate in VM
      const params = encodeHtlcParameters({
        hashLock: computedHash,
        recipientLockingBytecode: recipientBytecode,
        refundLockingBytecode: refundBytecode,
        tokenCategory: displayCatHex,
        tokenAmount: 5000n,
        refundHeight: 500000,
        maxFee: 1500n,
      });

      const spend = buildClaimTransaction({
        params,
        utxo: defaultUtxo,
        secret: xv001Secret,
        feeSats: 500n,
      });

      const res = verifyVm(vm, spend.libauthTx, [spend.sourceOutput]);
      expect(res).toBe(true);
    });

    it('XV-004: Category byte order conversion helpers', () => {
      const display =
        '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
      const internal =
        '4425a0e2ca5109d0261ec0a95d1cd6ffa3c389fb4ac0b5b50cb1a4afc5ac6924';

      expect(displayHexToInternalHex(display)).toBe(internal);
      expect(internalHexToDisplayHex(internal)).toBe(display);
      expect(libauth.binToHex(displayToInternalCategory(display))).toBe(
        internal,
      );
      expect(internalToDisplayCategory(libauth.hexToBin(internal))).toBe(
        display,
      );
    });

    it('derives correct P2SH32 standard and token-aware addresses', () => {
      const addressesChipnet = deriveHtlcAddresses(defaultParams, 'chipnet');
      expect(addressesChipnet.p2sh32Address.startsWith('bchtest:p')).toBe(true);
      expect(addressesChipnet.tokenAddress.startsWith('bchtest:r')).toBe(true);
      expect(addressesChipnet.lockingBytecode.length).toBe(35); // OP_HASH256 <32-byte hash> OP_EQUAL

      const addressesMainnet = deriveHtlcAddresses(defaultParams, 'mainnet');
      expect(addressesMainnet.p2sh32Address.startsWith('bitcoincash:p')).toBe(
        true,
      );
      expect(addressesMainnet.tokenAddress.startsWith('bitcoincash:r')).toBe(
        true,
      );
    });
  });
});
