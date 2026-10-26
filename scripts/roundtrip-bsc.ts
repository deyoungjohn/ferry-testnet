import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  sha256,
  toHex,
  formatUnits,
  parseGwei,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { readFileSync } from 'node:fs';

const FERRY_HTLC = '0x5A0C062f4B7b8fF2263530e12bc15De9C836a641';
const BSC_TESTNET_USDT = '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd';
const RPC_URL = 'https://data-seed-prebsc-1-s1.binance.org:8545';
const GAS_PRICE = parseGwei('3');

const htlcAbi = [
  {
    type: 'function',
    name: 'lockId',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'hashLock', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'locks',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'sender', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'hashLock', type: 'bytes32' },
      { name: 'deadline', type: 'uint64' },
      { name: 'state', type: 'uint8' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'lock',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'hashLock', type: 'bytes32' },
      { name: 'deadline', type: 'uint64' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'secret', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'refund',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

function getEnv(key: string): string {
  const envText = readFileSync(
    '/workspace/projects/ferry-app/.env.local',
    'utf8',
  );
  const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  if (!m || !m[1]) throw new Error(`Missing ${key} in .env.local`);
  return m[1].trim();
}

async function main() {
  console.log('=== Starting BSC Testnet (S-12) Live Round-Trip Execution ===');
  const userKey = getEnv('USER_EVM_PRIVATE_KEY') as `0x${string}`;
  const solverKey = getEnv('SOLVER_EVM_PRIVATE_KEY') as `0x${string}`;

  const userAccount = privateKeyToAccount(userKey);
  const solverAccount = privateKeyToAccount(solverKey);

  console.log(`User address:   ${userAccount.address}`);
  console.log(`Solver address: ${solverAccount.address}`);
  console.log(`HTLC contract:  ${FERRY_HTLC}`);
  console.log(`USDT contract:  ${BSC_TESTNET_USDT}`);

  const publicClient = createPublicClient({
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const userWallet = createWalletClient({
    account: userAccount,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  const solverWallet = createWalletClient({
    account: solverAccount,
    chain: bscTestnet,
    transport: http(RPC_URL),
  });

  // Verify balances
  const [userBnb, solverBnb, userUsdt, solverUsdt] = await Promise.all([
    publicClient.getBalance({ address: userAccount.address }),
    publicClient.getBalance({ address: solverAccount.address }),
    publicClient.readContract({
      address: BSC_TESTNET_USDT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAccount.address],
    }),
    publicClient.readContract({
      address: BSC_TESTNET_USDT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [solverAccount.address],
    }),
  ]);

  console.log(`User BNB:   ${formatUnits(userBnb, 18)} tBNB`);
  console.log(`Solver BNB: ${formatUnits(solverBnb, 18)} tBNB`);
  console.log(`User USDT:   ${formatUnits(userUsdt, 18)} USDT`);
  console.log(`Solver USDT: ${formatUnits(solverUsdt, 18)} USDT`);

  if (userUsdt < 2_000_000_000_000_000_000n) {
    throw new Error('User needs at least 2.0 USDT for round-trip tests');
  }

  const swapAmount = 1_000_000_000_000_000_000n; // 1.0 USDT (18 decimals)

  // ==========================================
  // ROUND TRIP 1: LOCK + CLAIM
  // ==========================================
  console.log('\n--- Round-Trip 1: Lock + Claim ---');
  const secret1 = toHex(
    crypto.getRandomValues(new Uint8Array(32)),
  ) as `0x${string}`;
  const hashLock1 = sha256(secret1);
  const currentBlock1 = await publicClient.getBlock({ blockTag: 'latest' });
  const deadline1 = currentBlock1.timestamp + 3600n; // 1 hour

  console.log(`HashLock 1: ${hashLock1}`);

  // 1. Approve
  console.log('User approving 1.0 USDT to FerryHTLC...');
  const approveTx1 = await userWallet.writeContract({
    address: BSC_TESTNET_USDT,
    abi: erc20Abi,
    functionName: 'approve',
    args: [FERRY_HTLC, swapAmount],
    gasPrice: GAS_PRICE,
  });
  const approveReceipt1 = await publicClient.waitForTransactionReceipt({
    hash: approveTx1,
  });
  console.log(
    `Approve 1 tx: ${approveTx1} (Block ${approveReceipt1.blockNumber}, gasUsed ${approveReceipt1.gasUsed})`,
  );

  // 2. Lock
  console.log('User locking 1.0 USDT for Solver...');
  const lockTx1 = await userWallet.writeContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'lock',
    args: [
      BSC_TESTNET_USDT,
      solverAccount.address,
      swapAmount,
      hashLock1,
      deadline1,
    ],
    gasPrice: GAS_PRICE,
  });
  const lockReceipt1 = await publicClient.waitForTransactionReceipt({
    hash: lockTx1,
  });
  const lockId1 = await publicClient.readContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'lockId',
    args: [userAccount.address, hashLock1],
  });
  console.log(
    `Lock 1 tx:    ${lockTx1} (Block ${lockReceipt1.blockNumber}, gasUsed ${lockReceipt1.gasUsed})`,
  );
  console.log(`LockId 1:     ${lockId1}`);

  // 3. Claim
  console.log('Solver claiming 1.0 USDT with secret...');
  const claimTx1 = await solverWallet.writeContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'claim',
    args: [lockId1, secret1],
    gasPrice: GAS_PRICE,
  });
  const claimReceipt1 = await publicClient.waitForTransactionReceipt({
    hash: claimTx1,
  });
  console.log(
    `Claim 1 tx:   ${claimTx1} (Block ${claimReceipt1.blockNumber}, gasUsed ${claimReceipt1.gasUsed})`,
  );

  // Verify state
  const lockState1 = await publicClient.readContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'locks',
    args: [lockId1],
  });
  console.log(`Lock 1 state: ${lockState1[6]} (Expected 2 = Claimed)`);
  if (lockState1[6] !== 2) throw new Error('Lock 1 state is not Claimed!');

  // ==========================================
  // ROUND TRIP 2: LOCK + REFUND
  // ==========================================
  console.log('\n--- Round-Trip 2: Lock + Refund ---');
  const secret2 = toHex(
    crypto.getRandomValues(new Uint8Array(32)),
  ) as `0x${string}`;
  const hashLock2 = sha256(secret2);
  const currentBlock2 = await publicClient.getBlock({ blockTag: 'latest' });
  const deadline2 = currentBlock2.timestamp + 45n; // 45 seconds deadline

  console.log(`HashLock 2: ${hashLock2}`);
  console.log(`Deadline 2: ${deadline2} (now: ${currentBlock2.timestamp})`);

  // 1. Approve
  console.log('User approving 1.0 USDT to FerryHTLC...');
  const approveTx2 = await userWallet.writeContract({
    address: BSC_TESTNET_USDT,
    abi: erc20Abi,
    functionName: 'approve',
    args: [FERRY_HTLC, swapAmount],
    gasPrice: GAS_PRICE,
  });
  const approveReceipt2 = await publicClient.waitForTransactionReceipt({
    hash: approveTx2,
  });
  console.log(
    `Approve 2 tx: ${approveTx2} (Block ${approveReceipt2.blockNumber}, gasUsed ${approveReceipt2.gasUsed})`,
  );

  // 2. Lock
  console.log('User locking 1.0 USDT for Solver (with short deadline)...');
  const lockTx2 = await userWallet.writeContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'lock',
    args: [
      BSC_TESTNET_USDT,
      solverAccount.address,
      swapAmount,
      hashLock2,
      deadline2,
    ],
    gasPrice: GAS_PRICE,
  });
  const lockReceipt2 = await publicClient.waitForTransactionReceipt({
    hash: lockTx2,
  });
  const lockId2 = await publicClient.readContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'lockId',
    args: [userAccount.address, hashLock2],
  });
  console.log(
    `Lock 2 tx:    ${lockTx2} (Block ${lockReceipt2.blockNumber}, gasUsed ${lockReceipt2.gasUsed})`,
  );
  console.log(`LockId 2:     ${lockId2}`);

  // Wait for deadline
  console.log('Waiting for deadline expiry on-chain...');
  while (true) {
    const b = await publicClient.getBlock({ blockTag: 'latest' });
    if (b.timestamp > deadline2) {
      console.log(
        `Block timestamp ${b.timestamp} > deadline ${deadline2}. Ready to refund!`,
      );
      break;
    }
    const rem = Number(deadline2 - b.timestamp);
    console.log(`Waiting... ${rem} seconds remaining`);
    await new Promise((r) => setTimeout(r, 4000));
  }

  // 3. Refund
  console.log('User executing refund...');
  const refundTx2 = await userWallet.writeContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'refund',
    args: [lockId2],
    gasPrice: GAS_PRICE,
  });
  const refundReceipt2 = await publicClient.waitForTransactionReceipt({
    hash: refundTx2,
  });
  console.log(
    `Refund 2 tx:  ${refundTx2} (Block ${refundReceipt2.blockNumber}, gasUsed ${refundReceipt2.gasUsed})`,
  );

  // Verify state
  const lockState2 = await publicClient.readContract({
    address: FERRY_HTLC,
    abi: htlcAbi,
    functionName: 'locks',
    args: [lockId2],
  });
  console.log(`Lock 2 state: ${lockState2[6]} (Expected 3 = Refunded)`);
  if (lockState2[6] !== 3) throw new Error('Lock 2 state is not Refunded!');

  // Final balances
  const [finalUserUsdt, finalSolverUsdt] = await Promise.all([
    publicClient.readContract({
      address: BSC_TESTNET_USDT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [userAccount.address],
    }),
    publicClient.readContract({
      address: BSC_TESTNET_USDT,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [solverAccount.address],
    }),
  ]);

  console.log('\n=== Summary Results ===');
  console.log(
    `User USDT:   ${formatUnits(finalUserUsdt, 18)} (Initial: ${formatUnits(userUsdt, 18)}, net delta: -1.0 USDT claimed by solver)`,
  );
  console.log(
    `Solver USDT: ${formatUnits(finalSolverUsdt, 18)} (Initial: ${formatUnits(solverUsdt, 18)}, net delta: +1.0 USDT)`,
  );
  console.log(`Lock 1 tx:   ${lockTx1}`);
  console.log(`Claim 1 tx:  ${claimTx1}`);
  console.log(`Lock 2 tx:   ${lockTx2}`);
  console.log(`Refund 2 tx: ${refundTx2}`);
  console.log('=== S-12 BSC Testnet Round-Trip Complete & Verified! ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
