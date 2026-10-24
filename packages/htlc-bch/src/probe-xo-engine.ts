import { Engine, DEFAULT_STORAGE_TYPE } from '@xo-cash/engine';
import { chipnetServersWithBlockchain } from '@electrum-cash/servers';
import { hexToBin } from '@bitauth/libauth';
import { ferryHtlcTemplate } from '../xo/index.js';
import fs from 'node:fs';

export async function testXoEngine() {
  console.log('[XO Engine] Creating test engine instance...');
  const mnemonic =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

  const dbDir = '/tmp/xo-engine-db';
  if (fs.existsSync(dbDir)) {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
  fs.mkdirSync(dbDir, { recursive: true });

  try {
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
    console.log('[XO Engine] Engine created successfully!');

    console.log('[XO Engine] Importing ferryHtlcTemplate...');
    const imported = await engine.importTemplate(ferryHtlcTemplate);
    console.log(
      `[XO Engine] Template imported! ID: ${imported.templateIdentifier}`,
    );

    // List templates
    const templates = await engine.listTemplates();
    console.log(`[XO Engine] Stored templates count: ${templates.length}`);

    console.log('[XO Engine] Testing createInvitation for action "lock"...');
    const invitation = await engine.createInvitation({
      templateIdentifier: imported.templateIdentifier,
      actionIdentifier: 'lock',
      roleIdentifier: 'locker',
      outputs: [
        {
          outputIdentifier: 'htlcOutput',
        },
      ],
      variables: [
        {
          variableIdentifier: 'hashLock',
          value: '00'.repeat(32),
        },
        {
          variableIdentifier: 'recipientLockingBytecode',
          value: '76a914' + '11'.repeat(20) + '88ac',
        },
        {
          variableIdentifier: 'refundLockingBytecode',
          value: '76a914' + '22'.repeat(20) + '88ac',
        },
        {
          variableIdentifier: 'tokenCategory',
          value: '33'.repeat(32),
        },
        {
          variableIdentifier: 'tokenAmount',
          value: 1000n,
        },
        {
          variableIdentifier: 'refundHeight',
          value: 330000,
        },
        {
          variableIdentifier: 'maxFee',
          value: 500,
        },
        {
          variableIdentifier: 'bchCarrySats',
          value: 2000,
        },
      ],
    });
    console.log(
      '[XO Engine] Invitation created successfully!',
      invitation.invitation.invitationIdentifier,
    );

    fs.mkdirSync('/tmp/xo-scratch', { recursive: true });
    fs.writeFileSync(
      '/tmp/xo-scratch/ferry-htlc-lock-invitation.json',
      JSON.stringify(
        invitation.invitation,
        (k, v) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ),
    );
    console.log(
      '[XO Engine] Saved invitation to /tmp/xo-scratch/ferry-htlc-lock-invitation.json',
    );

    console.log(
      '[XO Engine] Resolving output locking bytecode for htlcOutput...',
    );
    const resolvedOutput = await engine.resolveInvitationOutputLockingBytecode(
      invitation.invitation.invitationIdentifier,
      'htlcOutput',
    );
    console.log('[XO Engine] Resolved output bytecode:', resolvedOutput);

    console.log(
      '[XO Engine] Building invitation transaction for action "lock"...',
    );
    try {
      const builtTx = await engine.buildInvitationTransactionFromMergedCommit(
        invitation.invitation.invitationIdentifier,
      );
      console.log('[XO Engine] Built transaction:', builtTx);
    } catch (err: unknown) {
      console.error('[XO Engine buildInvitationTransaction error]:', err);
    }

    console.log('[XO Engine] Testing createInvitation for action "claim"...');
    const claimInvitation = await engine.createInvitation({
      templateIdentifier: imported.templateIdentifier,
      actionIdentifier: 'claim',
      roleIdentifier: 'claimer',
      inputs: [
        {
          inputIdentifier: 'claimHtlcInput',
          outpointTransactionHash: hexToBin('44'.repeat(32)),
          outpointIndex: 0,
        },
      ],
      outputs: [
        {
          outputIdentifier: 'claimRecipientOutput',
        },
      ],
      variables: [
        {
          variableIdentifier: 'secret',
          value: '55'.repeat(32),
        },
        {
          variableIdentifier: 'hashLock',
          value: '00'.repeat(32),
        },
        {
          variableIdentifier: 'recipientLockingBytecode',
          value: '76a914' + '11'.repeat(20) + '88ac',
        },
        {
          variableIdentifier: 'refundLockingBytecode',
          value: '76a914' + '22'.repeat(20) + '88ac',
        },
        {
          variableIdentifier: 'tokenCategory',
          value: '33'.repeat(32),
        },
        {
          variableIdentifier: 'tokenAmount',
          value: 1000n,
        },
        {
          variableIdentifier: 'refundHeight',
          value: 330000,
        },
        {
          variableIdentifier: 'maxFee',
          value: 500,
        },
        {
          variableIdentifier: 'bchCarrySats',
          value: 2000,
        },
      ],
    });
    console.log(
      '[XO Engine] Claim invitation created:',
      claimInvitation.invitation.invitationIdentifier,
    );

    console.log('[XO Engine] Attempting to signInvitation for input 0...');
    try {
      await engine.signInvitation(
        claimInvitation.invitation.invitationIdentifier,
        0,
      );
      console.log('[XO Engine] Signed invitation successfully!');
    } catch (err: unknown) {
      console.error('[XO Engine signInvitation error]:', err);
    }

    await engine.stop();
    return {
      success: true,
      invitationId: invitation.invitation.invitationIdentifier,
    };
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.error('[XO Engine Error]:', errorMsg);
    return { success: false, error: errorMsg };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  testXoEngine()
    .then((res) => {
      console.log('Result:', JSON.stringify(res, null, 2));
      process.exit(res.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
