import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { SolverDatabase } from '../../src/db/database.js';
import { SolverEngine } from '../../src/engine/runner.js';
import type { EvmChainAdapter } from '@ferry/chain-evm';
import type { BchQuorumClient } from '../../src/bch/quorum-client.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    dbPath: { type: 'string' },
    orderId: { type: 'string' },
    runStep: { type: 'boolean' },
    broadcastLogPath: { type: 'string' },
  },
});

if (!values.dbPath || !values.orderId) {
  process.exit(1);
}

const db = new SolverDatabase(values.dbPath);
const order = db.getOrder(values.orderId);

const fakeEvm = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  lockId: () => '0xmock-lock-id',
  getLock: async () => {
    if (order?.direction === 'BCH_TO_COUNTER') {
      if (order?.status === 'USER_LOCK_FINAL') {
        return { status: 'absent' as const };
      }
      if (order?.status === 'USER_CLAIM_SEEN' || order?.secret) {
        return {
          status: 'claimed' as const,
          claimTx: { txId: '0xclaim-tx' },
          secret: order.secret,
        };
      }
    }
    return { status: 'locked' as const };
  },
  isFinal: async () => true,
  lock: async () => {
    if (values.broadcastLogPath) {
      fs.appendFileSync(values.broadcastLogPath, `evm-lock:${order?.id}\n`);
    }
    return { chain: 'base' as const, txId: '0xchild-evm-lock-tx' };
  },
  claim: async () => ({ chain: 'base' as const, txId: '0xchild-claim-tx' }),
  watch: () => () => {},
} as unknown as EvmChainAdapter;

const sampleWif = 'cPJEAQPn5NYgtNy9HXR1q2q6vw4EghTgjscBFFseT4UT9gbpoDY9';
const tipHeight =
  order?.direction === 'BCH_TO_COUNTER'
    ? (order?.terms?.bchRefundHeight ?? 330144) - 144
    : order?.status === 'USER_LOCK_FINAL'
      ? (order?.terms?.bchRefundHeight ?? 330036) - 36
      : (order?.terms?.bchRefundHeight ?? 330000);

const fakeBch = {
  getQuorumStatus: () => ({
    quorumTip: tipHeight,
    tips: {},
    isQuorumHealthy: true,
    ageSeconds: 5,
  }),
  listUnspent: async () => {
    if (order?.direction === 'BCH_TO_COUNTER') {
      return [
        {
          tx_hash: order.userLockTxId ?? '11'.repeat(32),
          tx_pos: 0,
          value: Number(order.terms?.bchCarrySats ?? 3000n),
          height: 330001,
          token_data: {
            category: (
              order.terms?.bchTokenCategory ?? 'aa'.repeat(32)
            ).replace(/^0x/, ''),
            amount: (order.terms?.bchTokenAmount ?? 100n).toString(),
          },
        },
      ];
    }
    const utxos = [
      {
        tx_hash: '11'.repeat(32),
        tx_pos: 0,
        value: 20000,
        token_data: {
          category: 'aa'.repeat(32),
          amount: '10000000',
        },
      },
      {
        tx_hash: '22'.repeat(32),
        tx_pos: 0,
        value: 50000,
      },
    ];
    if (order?.solverLockTxId) {
      utxos.push({
        tx_hash: order.solverLockTxId,
        tx_pos: 0,
        value: Number(order.terms?.bchCarrySats ?? 3000n),
      });
    }
    return utxos;
  },
  getHistory: async () => {
    if (order?.direction === 'BCH_TO_COUNTER' && order.userLockTxId) {
      return [{ tx_hash: order.userLockTxId, height: 330001 }];
    }
    return [];
  },
  broadcast: async (txHex: string) => {
    if (values.broadcastLogPath) {
      fs.appendFileSync(values.broadcastLogPath, `${txHex}\n`);
    }
    return '0xchild-bch-tx';
  },
  subscribeScriptHash: async () => {},
  unsubscribeScriptHash: () => {},
} as unknown as BchQuorumClient;

const engine = new SolverEngine(
  db,
  fakeEvm,
  fakeBch,
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  sampleWif,
  'testnet',
);

// Exit cleanly if parent closes stdin
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));

// Signal ready to parent process as soon as engine and db are initialized
process.stdout.write('READY\n');

if (values.runStep) {
  engine
    .step()
    .then(() => {
      process.stdout.write('STEP_COMPLETE\n');
    })
    .catch((err) => {
      console.error('Child step error:', err);
      process.exit(1);
    });
} else {
  // Keep process running so parent can SIGKILL it
  setInterval(() => {}, 1000);
}
