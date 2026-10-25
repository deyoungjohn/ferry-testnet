import { describe, it, expect } from 'vitest';
import * as libauth from '@bitauth/libauth';
import {
  encodeHtlcParameters,
  deriveHtlcAddresses,
  buildClaimTransaction,
  buildRefundTransaction,
  selectLockInputs,
  buildLockTransaction,
  type LockUtxo,
} from '../src/index.js';

describe('BCH HTLC Lock Builder & Input Selection Suite', () => {
  const vm = libauth.createVirtualMachineBCH();

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

  const secret = new Uint8Array(32).fill(0x42);
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
  const userCashAddress = 'bchtest:qz3r8kfgl8qs94pyswepj6dylqf5avuf9y0650pprx';

  const samplePrivKey = new Uint8Array(32).fill(0x33);
  const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';
  const sampleWifAddress = 'bchtest:qqau9rtdjtvsw0a4uwklfqtet6h5g67wa5zg9v08d8';
  const samplePubkey =
    libauth.secp256k1.derivePublicKeyCompressed(samplePrivKey);
  if (typeof samplePubkey === 'string') throw new Error(samplePubkey);
  const samplePkh = libauth.ripemd160.hash(libauth.sha256.hash(samplePubkey));
  const sampleWifBytecode = new Uint8Array([
    0x76,
    0xa9,
    0x14,
    ...samplePkh,
    0x88,
    0xac,
  ]);

  const targetCategoryHex =
    'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';
  const otherCategoryHex =
    '1111111111111111111111111111111111111111111111111111111111111111';

  const defaultTerms = {
    hashLock,
    recipientLockingBytecode: recipientBytecode,
    refundLockingBytecode: refundBytecode,
    tokenCategory: targetCategoryHex,
    tokenAmount: 500n,
    refundHeight: 600000,
    maxFee: 1500n,
  };

  const canonicalParams = encodeHtlcParameters(defaultTerms);
  const derivedHtlc = deriveHtlcAddresses(canonicalParams, 'chipnet');

  describe('selectLockInputs', () => {
    it('refuses UTXOs carrying NFTs', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: {
            category: targetCategoryHex,
            amount: 1000n,
            nft: { capability: 'none', commitment: new Uint8Array(0) },
          },
        },
      ];

      expect(() =>
        selectLockInputs({
          utxos,
          tokenCategory: targetCategoryHex,
          tokenAmount: 500n,
        }),
      ).toThrow(/Insufficient token balance/);
    });

    it('refuses UTXOs carrying a different token category', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: {
            category: otherCategoryHex,
            amount: 1000n,
          },
        },
      ];

      expect(() =>
        selectLockInputs({
          utxos,
          tokenCategory: targetCategoryHex,
          tokenAmount: 500n,
        }),
      ).toThrow(/Insufficient token balance/);
    });

    it('sorts token UTXOs descending by amount (largest first)', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 200n },
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 800n },
        },
        {
          txid: '03'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 400n },
        },
        {
          txid: '04'.repeat(32),
          vout: 0,
          satoshis: 50000n,
        },
      ];

      const selected = selectLockInputs({
        utxos,
        tokenCategory: targetCategoryHex,
        tokenAmount: 700n,
      });

      // Largest token UTXO (800n) covers 700n by itself
      expect(selected.tokenInputs.length).toBe(1);
      expect(selected.tokenInputs[0]!.txid).toBe('02'.repeat(32));
      expect(selected.tokenInputs[0]!.token?.amount).toBe(800n);
      expect(selected.hasTokenChange).toBe(true);
      expect(selected.tokenChangeAmount).toBe(100n);
    });

    it('breaks ties deterministically by txid and vout', () => {
      const utxos: LockUtxo[] = [
        {
          txid: 'bb'.repeat(32),
          vout: 1,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
        },
        {
          txid: 'aa'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
        },
        {
          txid: '04'.repeat(32),
          vout: 0,
          satoshis: 50000n,
        },
      ];

      const selected = selectLockInputs({
        utxos,
        tokenCategory: targetCategoryHex,
        tokenAmount: 400n,
      });

      expect(selected.tokenInputs[0]!.txid).toBe('aa'.repeat(32));
    });

    it('picks the smallest sufficient single pure BCH UTXO', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n, // covers 1000n tokens, contributes 1000 sats
          token: { category: targetCategoryHex, amount: 1000n },
        },
        // Deficit will be ~2000 carry + 600 fee = 2600 - 1000 = ~1600 sats needed
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 50000n, // sufficient, but large
        },
        {
          txid: '03'.repeat(32),
          vout: 0,
          satoshis: 5000n, // smallest sufficient!
        },
        {
          txid: '04'.repeat(32),
          vout: 0,
          satoshis: 500n, // insufficient alone
        },
      ];

      const selected = selectLockInputs({
        utxos,
        tokenCategory: targetCategoryHex,
        tokenAmount: 1000n,
        bchCarrySats: 2000n,
      });

      expect(selected.bchInputs.length).toBe(1);
      expect(selected.bchInputs[0]!.txid).toBe('03'.repeat(32));
      expect(selected.bchInputs[0]!.satoshis).toBe(5000n);
    });

    it('accumulates smallest pure BCH UTXOs when no single UTXO covers deficit', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 1000n },
        },
        // Deficit ~2000 carry + 600 fee = 2600 - 1000 = 1600 sats needed
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 700n,
        },
        {
          txid: '03'.repeat(32),
          vout: 0,
          satoshis: 600n,
        },
        {
          txid: '04'.repeat(32),
          vout: 0,
          satoshis: 800n,
        },
      ];

      const selected = selectLockInputs({
        utxos,
        tokenCategory: targetCategoryHex,
        tokenAmount: 1000n,
        bchCarrySats: 2000n,
      });

      // 600 + 700 = 1300 < deficit, so 600 + 700 + 800 = 2100 >= deficit
      expect(selected.bchInputs.length).toBe(3);
      expect(selected.bchInputs[0]!.satoshis).toBe(600n);
      expect(selected.bchInputs[1]!.satoshis).toBe(700n);
      expect(selected.bchInputs[2]!.satoshis).toBe(800n);
    });

    it('accepts Fulcrum UTXOs format (tx_hash, tx_pos, value, token_data)', () => {
      const fulcrumUtxos = [
        {
          tx_hash: '11'.repeat(32),
          tx_pos: 2,
          value: 1000,
          height: 12345,
          token_data: {
            category: targetCategoryHex,
            amount: '500',
          },
        },
        {
          tx_hash: '22'.repeat(32),
          tx_pos: 0,
          value: 10000,
          height: 12345,
        },
      ];

      const selected = selectLockInputs({
        utxos: fulcrumUtxos,
        tokenCategory: targetCategoryHex,
        tokenAmount: 500n,
        userAddress: userCashAddress,
      });

      expect(selected.tokenInputs.length).toBe(1);
      expect(selected.tokenInputs[0]!.txid).toBe('11'.repeat(32));
      expect(selected.tokenInputs[0]!.vout).toBe(2);
      expect(selected.tokenInputs[0]!.token?.amount).toBe(500n);
      expect(selected.bchInputs[0]!.txid).toBe('22'.repeat(32));
    });
  });

  describe('buildLockTransaction', () => {
    it('produces exact HTLC output matching deriveHtlcAddresses bytecode', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 10000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const result = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
        wif: sampleWif,
      });

      // Output 0 is the HTLC output
      const htlcOutput = result.unsigned.transaction.outputs[0]!;
      expect(libauth.binToHex(htlcOutput.lockingBytecode)).toBe(
        libauth.binToHex(derivedHtlc.lockingBytecode),
      );
      expect(htlcOutput.valueSatoshis).toBe(3000n);
      expect(htlcOutput.token?.amount).toBe(500n);
      expect(libauth.binToHex(htlcOutput.token!.category)).toBe(
        targetCategoryHex,
      );

      // Check return fields
      expect(result.htlcOutputIndex).toBe(0);
      expect(result.htlcP2sh32Address).toBe(derivedHtlc.p2sh32Address);
      expect(result.htlcTokenAddress).toBe(derivedHtlc.tokenAddress);
    });

    it('performs exact change math with token change and BCH change', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 1000n }, // 500 needed, 500 change
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 20000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const bchCarrySats = 3000n;
      const tokenChangeCarrySats = 1000n;
      const explicitFee = 800n;

      const result = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats,
        tokenChangeCarrySats,
        feeSats: explicitFee,
      });

      // Total inputs satoshis: 1000 + 20000 = 21000
      // Allocated: 3000 (HTLC) + 1000 (token change) + 800 (fee) = 4800
      // Remaining BCH change: 21000 - 4800 = 16200
      expect(result.tokenChangeAmount).toBe(500n);
      expect(result.bchChangeSats).toBe(16200n);
      expect(result.feeSats).toBe(explicitFee);

      const outputs = result.unsigned.transaction.outputs;
      expect(outputs.length).toBe(3);

      // Output 0: HTLC
      expect(outputs[0]!.valueSatoshis).toBe(3000n);
      expect(outputs[0]!.token?.amount).toBe(500n);

      // Output 1: Token change
      expect(outputs[1]!.valueSatoshis).toBe(1000n);
      expect(outputs[1]!.token?.amount).toBe(500n);
      expect(libauth.binToHex(outputs[1]!.lockingBytecode)).toBe(
        libauth.binToHex(sampleWifBytecode),
      );

      // Output 2: BCH change
      expect(outputs[2]!.valueSatoshis).toBe(16200n);
      expect(outputs[2]!.token).toBeUndefined();

      // Conservation of satoshis: in == outputs + fee
      const totalOutSats = outputs.reduce(
        (sum, out) => sum + out.valueSatoshis,
        0n,
      );
      expect(totalOutSats + result.feeSats).toBe(21000n);
    });

    it('absorbs sub-dust BCH change into fee (dust rule respected)', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 3000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      // Total in: 4000 sats.
      // bchCarry: 3000 sats.
      // fee: 800 sats.
      // Remaining BCH: 4000 - 3000 - 800 = 200 sats (< dust limit 546 sats).
      const result = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
        feeSats: 800n,
        dustLimitSats: 546n,
      });

      // Sub-dust change is absorbed into fee: fee becomes 800 + 200 = 1000 sats
      expect(result.bchChangeSats).toBe(0n);
      expect(result.feeSats).toBe(1000n);
      // Only 1 output (HTLC), no dust change output
      expect(result.unsigned.transaction.outputs.length).toBe(1);
      expect(result.unsigned.transaction.outputs[0]!.valueSatoshis).toBe(3000n);
    });

    it('produces valid WizardConnect WcSignTransactionRequest format', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 1,
          satoshis: 10000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const result = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
      });

      const { unsigned } = result;
      expect(unsigned.txHex).toBeDefined();
      expect(unsigned.txid.length).toBe(64);

      // Check WcSignTransactionRequest structure
      const { wcSignRequest } = unsigned;
      expect(wcSignRequest.transaction).toBe(unsigned.txHex);
      expect(wcSignRequest.broadcast).toBe(false);
      expect(wcSignRequest.userPrompt).toContain('Lock 500 tokens');

      // Check sourceOutputs matching WcSourceOutput
      expect(wcSignRequest.sourceOutputs.length).toBe(2);
      expect(wcSignRequest.sourceOutputs[0]!.outpointIndex).toBe(0);
      expect(wcSignRequest.sourceOutputs[0]!.valueSatoshis).toBe(1000n);
      expect(wcSignRequest.sourceOutputs[0]!.token?.amount).toBe(500n);
      expect(wcSignRequest.sourceOutputs[1]!.outpointIndex).toBe(1);
      expect(wcSignRequest.sourceOutputs[1]!.valueSatoshis).toBe(10000n);
    });

    it('produces valid signed transaction when WIF is provided', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 10000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const result = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
        wif: sampleWif,
      });

      expect(result.signed).toBeDefined();
      expect(result.signed!.txHex.length).toBeGreaterThan(0);
      expect(result.signed!.txid.length).toBe(64);
      expect(result.signed!.transaction.inputs.length).toBe(2);
      // Signed inputs have non-empty unlockingBytecode
      expect(
        result.signed!.transaction.inputs[0]!.unlockingBytecode.length,
      ).toBeGreaterThan(0);
      expect(
        result.signed!.transaction.inputs[1]!.unlockingBytecode.length,
      ).toBeGreaterThan(0);
    });
  });

  describe('Libauth VM spendability: spending HTLC output produced by lock builder', () => {
    it('HTLC output can be spent by buildClaimTransaction in Libauth VM', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 10000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const lockResult = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
        wif: sampleWif,
      });

      const htlcOutput = lockResult.unsigned.transaction.outputs[0]!;

      // Spend output 0 with buildClaimTransaction
      const claimTx = buildClaimTransaction({
        params: canonicalParams,
        utxo: {
          txid: lockResult.signed!.txid,
          vout: lockResult.htlcOutputIndex,
          satoshis: htlcOutput.valueSatoshis,
        },
        secret,
        feeSats: 500n,
      });

      // Verify spend in Libauth VM using the lock transaction's HTLC output as source output
      const res = verifyVm(vm, claimTx.libauthTx, [htlcOutput]);
      expect(res).toBe(true);
    });

    it('HTLC output can be spent by buildRefundTransaction in Libauth VM', () => {
      const utxos: LockUtxo[] = [
        {
          txid: '01'.repeat(32),
          vout: 0,
          satoshis: 1000n,
          token: { category: targetCategoryHex, amount: 500n },
          lockingBytecode: sampleWifBytecode,
        },
        {
          txid: '02'.repeat(32),
          vout: 0,
          satoshis: 10000n,
          lockingBytecode: sampleWifBytecode,
        },
      ];

      const lockResult = buildLockTransaction({
        params: defaultTerms,
        utxos,
        changeAddress: sampleWifAddress,
        bchCarrySats: 3000n,
        wif: sampleWif,
      });

      const htlcOutput = lockResult.unsigned.transaction.outputs[0]!;

      // Spend output 0 with buildRefundTransaction
      const refundTx = buildRefundTransaction({
        params: canonicalParams,
        utxo: {
          txid: lockResult.signed!.txid,
          vout: lockResult.htlcOutputIndex,
          satoshis: htlcOutput.valueSatoshis,
        },
        feeSats: 500n,
      });

      // Verify spend in Libauth VM using the lock transaction's HTLC output as source output
      const res = verifyVm(vm, refundTx.libauthTx, [htlcOutput]);
      expect(res).toBe(true);
    });
  });
});
