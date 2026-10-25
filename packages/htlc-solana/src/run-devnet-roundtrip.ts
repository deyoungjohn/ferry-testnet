import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import anchorPkg from '@coral-xyz/anchor';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import {
  getFerryProgram,
  buildLockInstruction,
  buildClaimInstruction,
  buildRefundInstruction,
  fetchLockState,
  PROGRAM_ID,
} from './index.js';

const { AnchorProvider, Wallet } = anchorPkg;

const DEVNET_RPC = 'https://api.devnet.solana.com';

function sha256(data: Uint8Array): Uint8Array {
  return createHash('sha256').update(data).digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function loadEnvLocal(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '../../.env.local');
  const fallbackPath = path.resolve(process.cwd(), '.env.local');
  const target = fs.existsSync(envPath) ? envPath : fallbackPath;
  if (!fs.existsSync(target)) {
    throw new Error(`.env.local not found at ${target}`);
  }
  const content = fs.readFileSync(target, 'utf8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
  return env;
}

export interface RoundTripResult {
  programId: string;
  mint: string;
  isMockMint: boolean;
  lockClaim: {
    lockTx: string;
    lockFeeLamports: number;
    claimTx: string;
    claimFeeLamports: number;
    userSolBefore: number;
    userSolAfter: number;
    userSolDelta: number;
    tokensClaimed: string;
    claimDurationMs: number;
  };
  lockRefund: {
    lockTx: string;
    refundTx: string;
    refundFeeLamports: number;
    tokensRefunded: string;
    refundDurationMs: number;
  };
}

export async function runSolanaDevnetRoundTrip(): Promise<RoundTripResult> {
  console.log('Connecting to Solana Devnet:', DEVNET_RPC);
  const connection = new Connection(DEVNET_RPC, 'confirmed');

  const env = loadEnvLocal();
  const deployerKey = env['DEPLOYER_SOL_KEYPAIR'];
  const solverKey = env['SOLVER_SOL_KEYPAIR'];
  const userKey = env['USER_SOL_KEYPAIR'];

  if (!deployerKey || !solverKey || !userKey) {
    throw new Error('Missing Solana keypairs in .env.local');
  }

  const deployer = Keypair.fromSecretKey(bs58.decode(deployerKey));
  const solver = Keypair.fromSecretKey(bs58.decode(solverKey));
  const user = Keypair.fromSecretKey(bs58.decode(userKey));

  console.log('Deployer:', deployer.publicKey.toBase58());
  console.log('Solver:  ', solver.publicKey.toBase58());
  console.log('User:    ', user.publicKey.toBase58());

  const deployerBal = await connection.getBalance(deployer.publicKey);
  const solverBal = await connection.getBalance(solver.publicKey);
  const userBal = await connection.getBalance(user.publicKey);

  console.log(
    `Balances: Deployer=${deployerBal / LAMPORTS_PER_SOL} SOL, Solver=${solverBal / LAMPORTS_PER_SOL} SOL, User=${userBal / LAMPORTS_PER_SOL} SOL`,
  );

  const provider = new AnchorProvider(connection, new Wallet(deployer), {
    commitment: 'confirmed',
  });
  const program = getFerryProgram(provider);

  // Check Circle USDC on devnet
  const circleUsdcMint = new PublicKey(
    '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  );
  let mint = circleUsdcMint;
  let isMockMint = false;

  let solverCircleUsdcBal = 0n;
  try {
    const solverAta = getAssociatedTokenAddressSync(
      circleUsdcMint,
      solver.publicKey,
    );
    const account = await getAccount(connection, solverAta);
    solverCircleUsdcBal = account.amount;
  } catch {
    // Unfunded on Circle USDC
  }

  if (solverCircleUsdcBal > 0n) {
    console.log(
      `Using live Circle Devnet USDC (${circleUsdcMint.toBase58()}), solver balance: ${solverCircleUsdcBal}`,
    );
  } else {
    isMockMint = true;
    console.log(
      'Solver has 0 Circle Devnet USDC. Creating devnet mock USDC mint (6 decimals)...',
    );
    mint = await createMint(connection, deployer, deployer.publicKey, null, 6);
    console.log(
      `Created Devnet Mock USDC Mint: ${mint.toBase58()} (6 decimals)`,
    );

    // Fund Solver ATA
    const solverAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      deployer,
      mint,
      solver.publicKey,
    );
    await mintTo(
      connection,
      deployer,
      mint,
      solverAtaAcc.address,
      deployer.publicKey,
      100_000_000n,
    );

    // Fund User ATA
    const userAtaAcc = await getOrCreateAssociatedTokenAccount(
      connection,
      deployer,
      mint,
      user.publicKey,
    );
    await mintTo(
      connection,
      deployer,
      mint,
      userAtaAcc.address,
      deployer.publicKey,
      100_000_000n,
    );
    console.log('Funded Solver and User ATAs with 100 mock USDC each');
  }

  const solverAta = getAssociatedTokenAddressSync(mint, solver.publicKey);
  const userAta = getAssociatedTokenAddressSync(mint, user.publicKey);

  // ==========================================
  // ROUND TRIP 1: Lock -> Claim (S-09)
  // ==========================================
  console.log('\n--- Round Trip 1: Solver Lock -> User Claim (Relayed) ---');
  const secret = randomBytes(32);
  const hashLock = sha256(secret);
  const swapAmount = 5_000_000n; // 5 USDC (6 decimals)
  const now = Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 600); // 10 minutes

  console.log('Building Lock transaction...');
  const { instruction: lockIx, lockPda } = await buildLockInstruction({
    program,
    payer: solver.publicKey,
    owner: solver.publicKey,
    recipient: user.publicKey,
    mint,
    amount: swapAmount,
    hashLock,
    deadline,
    ownerTokenAccount: solverAta,
  });

  const t0Lock = Date.now();
  const lockTx = new Transaction().add(lockIx);
  const lockSig = await sendAndConfirmTransaction(connection, lockTx, [solver]);
  const lockDurationMs = Date.now() - t0Lock;
  console.log(`Lock tx confirmed: ${lockSig} (${lockDurationMs} ms)`);

  const lockTxInfo = await connection.getTransaction(lockSig, {
    maxSupportedTransactionVersion: 0,
  });
  const lockFee = lockTxInfo?.meta?.fee ?? 5000;

  // Verify lock state on devnet
  const lockState = await fetchLockState(program, lockPda);
  console.log('Devnet LockState confirmed:', {
    owner: lockState?.owner.toBase58(),
    recipient: lockState?.recipient.toBase58(),
    amount: lockState?.amount.toString(),
  });

  // Record user SOL balance BEFORE claim
  const userSolBefore = await connection.getBalance(user.publicKey);
  console.log(`User SOL balance before claim: ${userSolBefore} lamports`);

  // Relayer (Deployer) executes claim
  console.log('Building Claim transaction (Relayer = Deployer)...');
  const { instruction: claimIx } = await buildClaimInstruction({
    program,
    payer: deployer.publicKey,
    owner: solver.publicKey,
    recipient: user.publicKey,
    mint,
    hashLock,
    secret,
    payerRentDest: solver.publicKey,
    recipientTokenAccount: userAta,
  });

  const t0Claim = Date.now();
  const claimTx = new Transaction().add(claimIx);
  const claimSig = await sendAndConfirmTransaction(connection, claimTx, [
    deployer,
  ]);
  const claimDurationMs = Date.now() - t0Claim;
  console.log(`Claim tx confirmed: ${claimSig} (${claimDurationMs} ms)`);

  const claimTxInfo = await connection.getTransaction(claimSig, {
    maxSupportedTransactionVersion: 0,
  });
  const claimFee = claimTxInfo?.meta?.fee ?? 5000;

  // Record user SOL balance AFTER claim
  const userSolAfter = await connection.getBalance(user.publicKey);
  const userSolDelta = userSolAfter - userSolBefore;
  console.log(`User SOL balance after claim:  ${userSolAfter} lamports`);
  console.log(
    `User SOL delta:                ${userSolDelta} lamports (MUST BE EXACTLY 0)`,
  );

  if (userSolDelta !== 0) {
    throw new Error(
      `CRITICAL S-09 FAILURE: User SOL balance changed by ${userSolDelta} lamports!`,
    );
  }
  console.log(
    '✓ S-09 INVARIANT VERIFIED: User SOL balance was completely untouched!',
  );

  // Verify lock PDA is closed
  const closedState = await fetchLockState(program, lockPda);
  console.log(
    'LockState account closed on devnet:',
    closedState === null ? 'YES (null)' : 'NO',
  );

  // ==========================================
  // ROUND TRIP 2: Lock -> Refund
  // ==========================================
  console.log('\n--- Round Trip 2: User Lock -> Refund After Deadline ---');
  const refundSecret = randomBytes(32);
  const refundHashLock = sha256(refundSecret);
  const refundAmount = 2_000_000n; // 2 USDC
  const refundNow = Math.floor(Date.now() / 1000);
  const refundDeadline = BigInt(refundNow + 8); // 8 seconds

  const { instruction: refundLockIx, lockPda: refundLockPda } =
    await buildLockInstruction({
      program,
      payer: user.publicKey,
      owner: user.publicKey,
      recipient: solver.publicKey,
      mint,
      amount: refundAmount,
      hashLock: refundHashLock,
      deadline: refundDeadline,
      ownerTokenAccount: userAta,
    });

  const refundLockSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(refundLockIx),
    [user],
  );
  console.log(`Refund lock tx confirmed: ${refundLockSig}`);

  console.log('Waiting 10s for deadline to elapse...');
  await sleep(10_000);

  console.log('Executing Refund transaction (caller = Deployer)...');
  const { instruction: refundIx } = await buildRefundInstruction({
    program,
    payer: deployer.publicKey,
    owner: user.publicKey,
    mint,
    hashLock: refundHashLock,
    payerRentDest: user.publicKey,
    ownerTokenAccount: userAta,
  });

  const t0Refund = Date.now();
  const refundSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(refundIx),
    [deployer],
  );
  const refundDurationMs = Date.now() - t0Refund;
  console.log(`Refund tx confirmed: ${refundSig} (${refundDurationMs} ms)`);

  const refundTxInfo = await connection.getTransaction(refundSig, {
    maxSupportedTransactionVersion: 0,
  });
  const refundFee = refundTxInfo?.meta?.fee ?? 5000;

  const userBalAfterRefund = (await getAccount(connection, userAta)).amount;
  console.log(
    `User token balance after refund: ${userBalAfterRefund} (refunded: ${refundAmount})`,
  );

  const closedRefundState = await fetchLockState(program, refundLockPda);
  console.log(
    'Refund LockState account closed on devnet:',
    closedRefundState === null ? 'YES (null)' : 'NO',
  );

  return {
    programId: PROGRAM_ID.toBase58(),
    mint: mint.toBase58(),
    isMockMint,
    lockClaim: {
      lockTx: lockSig,
      lockFeeLamports: lockFee,
      claimTx: claimSig,
      claimFeeLamports: claimFee,
      userSolBefore,
      userSolAfter,
      userSolDelta,
      tokensClaimed: swapAmount.toString(),
      claimDurationMs,
    },
    lockRefund: {
      lockTx: refundLockSig,
      refundTx: refundSig,
      refundFeeLamports: refundFee,
      tokensRefunded: refundAmount.toString(),
      refundDurationMs,
    },
  };
}

runSolanaDevnetRoundTrip()
  .then((res) => {
    console.log('\n==============================================');
    console.log('SOLANA DEVNET ROUND TRIP COMPLETE AND GREEN');
    console.log('==============================================');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Round trip failed:', err);
    process.exit(1);
  });
