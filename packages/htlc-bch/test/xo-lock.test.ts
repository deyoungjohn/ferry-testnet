import { describe, it, expect } from 'vitest';
import { Engine, DEFAULT_STORAGE_TYPE } from '@xo-cash/engine';
import { chipnetServersWithBlockchain } from '@electrum-cash/servers';
import * as libauth from '@bitauth/libauth';
import fs from 'node:fs';
import { ferryHtlcTemplate } from '../xo/index.js';
import {
  encodeHtlcParameters,
  deriveHtlcAddresses,
  displayHexToInternalHex,
} from '../src/index.js';

// Gated for offline/clean clone safety: run with FERRY_LIVE_TESTS=1
describe.skipIf(!process.env.FERRY_LIVE_TESTS)(
  'XO Hybrid Lock Check & Workaround Analysis',
  () => {
  it('creates lock invitation, resolves locking bytecode byte-identical to CashScript, and identifies engine boundaries', async () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const dbDir = '/tmp/xo-test-lock-db';
    if (fs.existsSync(dbDir))
      fs.rmSync(dbDir, { recursive: true, force: true });
    fs.mkdirSync(dbDir, { recursive: true });

    const server = chipnetServersWithBlockchain[0];
    if (!server) {
      throw new Error('No chipnet server found');
    }
    const engine = await Engine.create(mnemonic, {
      network: 'chipnet',
      storageType: DEFAULT_STORAGE_TYPE,
      databasePath: dbDir,
      electrumServers: [server],
    });

    const imported = await engine.importTemplate(ferryHtlcTemplate);
    expect(imported.templateIdentifier).toBeDefined();

    const secretBytes = new Uint8Array(32).fill(0x42);
    const hashLockBytes = libauth.sha256.hash(secretBytes);
    const hashLockHex = libauth.binToHex(hashLockBytes);
    const recipientLocking = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x11),
      0x88,
      0xac,
    ]);
    const refundLocking = new Uint8Array([
      0x76,
      0xa9,
      0x14,
      ...new Uint8Array(20).fill(0x22),
      0x88,
      0xac,
    ]);
    const displayCategory =
      'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac';
    const internalCatHex = displayHexToInternalHex(displayCategory);
    const tokenAmount = 500n;
    const refundHeight = 350000;
    const maxFee = 500;
    const bchCarrySats = 2000;

    // 1. Create lock invitation
    const lockInvitation = await engine.createInvitation({
      templateIdentifier: imported.templateIdentifier,
      actionIdentifier: 'lock',
      roleIdentifier: 'locker',
      outputs: [
        {
          outputIdentifier: 'htlcOutput',
        },
      ],
      variables: [
        { variableIdentifier: 'hashLock', value: hashLockHex },
        {
          variableIdentifier: 'recipientLockingBytecode',
          value: libauth.binToHex(recipientLocking),
        },
        {
          variableIdentifier: 'refundLockingBytecode',
          value: libauth.binToHex(refundLocking),
        },
        { variableIdentifier: 'tokenCategory', value: internalCatHex },
        { variableIdentifier: 'tokenAmount', value: tokenAmount },
        { variableIdentifier: 'refundHeight', value: refundHeight },
        { variableIdentifier: 'maxFee', value: maxFee },
        { variableIdentifier: 'bchCarrySats', value: bchCarrySats },
      ],
    });
    const invitationId = lockInvitation.invitation.invitationIdentifier;
    expect(invitationId).toBeDefined();

    // 2. Resolve locking bytecode via XO Engine
    const xoLockingBytecodeHex =
      await engine.resolveInvitationOutputLockingBytecode(
        invitationId,
        'htlcOutput',
      );

    // 3. Compare with CashScript derived locking bytecode
    const cashScriptParams = encodeHtlcParameters({
      hashLock: hashLockBytes,
      recipientLockingBytecode: recipientLocking,
      refundLockingBytecode: refundLocking,
      tokenCategory: displayCategory,
      tokenAmount,
      refundHeight,
      maxFee: BigInt(maxFee),
    });
    const cashScriptAddresses = deriveHtlcAddresses(
      cashScriptParams,
      'chipnet',
    );
    const cashScriptLockingBytecodeHex = libauth.binToHex(
      cashScriptAddresses.lockingBytecode,
    );

    expect(xoLockingBytecodeHex).toBe(cashScriptLockingBytecodeHex);

    // 4. Verify XO signInvitation fails because inputs are not tracked in engine state
    await expect(engine.signInvitation(invitationId, 0)).rejects.toThrow(
      /expected a commit that introduced the input|not tracked by this account/,
    );

    // 5. Workaround check: Engine builds unsigned transaction skeleton for claim
    const dummyHtlcTxid = 'bb'.repeat(32);
    const claimInvitation = await engine.createInvitation({
      templateIdentifier: imported.templateIdentifier,
      actionIdentifier: 'claim',
      roleIdentifier: 'claimer',
      inputs: [
        {
          inputIdentifier: 'claimHtlcInput',
          outpointTransactionHash: libauth.hexToBin(dummyHtlcTxid),
          outpointIndex: 0,
        },
      ],
      outputs: [
        {
          outputIdentifier: 'claimRecipientOutput',
        },
      ],
      variables: [
        { variableIdentifier: 'secret', value: libauth.binToHex(secretBytes) },
        { variableIdentifier: 'hashLock', value: hashLockHex },
        {
          variableIdentifier: 'recipientLockingBytecode',
          value: libauth.binToHex(recipientLocking),
        },
        {
          variableIdentifier: 'refundLockingBytecode',
          value: libauth.binToHex(refundLocking),
        },
        { variableIdentifier: 'tokenCategory', value: internalCatHex },
        { variableIdentifier: 'tokenAmount', value: tokenAmount },
        { variableIdentifier: 'refundHeight', value: refundHeight },
        { variableIdentifier: 'maxFee', value: maxFee },
        { variableIdentifier: 'bchCarrySats', value: bchCarrySats },
      ],
    });

    const builtSkeleton =
      await engine.buildInvitationTransactionFromMergedCommit(
        claimInvitation.invitation.invitationIdentifier,
      );
    expect(builtSkeleton.serializedTransaction).toBeDefined();
    expect(builtSkeleton.feeEstimateInputCount).toBe(1);
    expect(builtSkeleton.feeEstimateOutputCount).toBe(1);

    // But unlocking bytecode generation fails because outpoint is not tracked locally
    await expect(
      engine.generateUnlockingBytecode(
        claimInvitation.invitation.invitationIdentifier,
        0,
      ),
    ).rejects.toThrow(/not tracked by this account/);

    await engine.stop();
  });
});
