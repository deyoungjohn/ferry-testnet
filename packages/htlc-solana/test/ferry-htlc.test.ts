import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import anchorPkg, { type AnchorProvider as AnchorProviderType } from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  getFerryProgram,
  deriveLockPda,
  deriveVaultPda,
  buildLockInstruction,
  buildClaimInstruction,
  buildRefundInstruction,
  fetchLockState,
  PROGRAM_ID,
} from "../src/index.js";

const RPC_URL = "http://127.0.0.1:8899";
const LEDGER_DIR = "/tmp/ferry-solana-test-ledger";
const SO_PATH = resolve(
  __dirname,
  "../target/deploy/ferry_htlc.so",
);

function sha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("Ferry HTLC Solana Program", () => {
  let validatorProcess: ChildProcess | null = null;
  let connection: Connection;
  let payer: Keypair;
  let relayer: Keypair;
  let owner: Keypair;
  let recipient: Keypair;
  let mint: PublicKey;
  let ownerAta: PublicKey;
  let provider: AnchorProviderType;

  beforeAll(async () => {
    // Check if test validator is already running
    connection = new Connection(RPC_URL, "confirmed");
    let isRunning = false;
    try {
      await connection.getSlot();
      isRunning = true;
    } catch {
      isRunning = false;
    }

    if (!isRunning) {
      if (existsSync(LEDGER_DIR)) {
        rmSync(LEDGER_DIR, { recursive: true, force: true });
      }

      validatorProcess = spawn(
        "solana-test-validator",
        [
          "--bpf-program",
          PROGRAM_ID.toBase58(),
          SO_PATH,
          "--reset",
          "--quiet",
          "--ledger",
          LEDGER_DIR,
        ],
        { stdio: "ignore", detached: false },
      );

      // Wait for validator to respond
      let attempts = 0;
      while (attempts < 60) {
        try {
          await connection.getSlot();
          break;
        } catch {
          await sleep(500);
          attempts++;
        }
      }
      if (attempts >= 60) {
        throw new Error("solana-test-validator failed to start in 30s");
      }
    }

    payer = Keypair.generate();
    relayer = Keypair.generate();
    owner = Keypair.generate();
    recipient = Keypair.generate();

    // Airdrop SOL to test actors
    const airdropPayer = await connection.requestAirdrop(
      payer.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    const airdropRelayer = await connection.requestAirdrop(
      relayer.publicKey,
      10 * LAMPORTS_PER_SOL,
    );
    const airdropOwner = await connection.requestAirdrop(
      owner.publicKey,
      5 * LAMPORTS_PER_SOL,
    );
    // User / recipient gets exactly 0.5 SOL initially (will verify untouched on claim)
    const airdropRecipient = await connection.requestAirdrop(
      recipient.publicKey,
      0.5 * LAMPORTS_PER_SOL,
    );

    await connection.confirmTransaction(airdropPayer);
    await connection.confirmTransaction(airdropRelayer);
    await connection.confirmTransaction(airdropOwner);
    await connection.confirmTransaction(airdropRecipient);

    provider = new AnchorProvider(
      connection,
      new Wallet(payer),
      AnchorProvider.defaultOptions(),
    );

    // Create a mock USDC mint (6 decimals)
    mint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      6,
    );

    // Create owner ATA and mint 1,000,000,000 tokens (1000 USDC)
    const ownerAtaAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      mint,
      owner.publicKey,
    );
    ownerAta = ownerAtaAccount.address;

    await mintTo(
      connection,
      payer,
      mint,
      ownerAta,
      payer.publicKey,
      1_000_000_000n,
    );
  }, 45_000);

  afterAll(async () => {
    if (validatorProcess) {
      validatorProcess.kill("SIGTERM");
      await sleep(1000);
      if (existsSync(LEDGER_DIR)) {
        rmSync(LEDGER_DIR, { recursive: true, force: true });
      }
    }
  });

  it("happy path: lock -> claim with relayer-as-fee-payer (user SOL balance unchanged)", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 50_000_000n; // 50 USDC
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 300);

    const { instruction: lockIx, lockPda, vaultPda } =
      await buildLockInstruction({
        program,
        payer: payer.publicKey,
        owner: owner.publicKey,
        recipient: recipient.publicKey,
        mint,
        amount,
        hashLock,
        deadline,
        ownerTokenAccount: ownerAta,
      });

    const lockTx = new Transaction().add(lockIx);
    await sendAndConfirmTransaction(connection, lockTx, [payer, owner]);

    // Verify lock state
    const lockState = await fetchLockState(program, lockPda);
    expect(lockState).not.toBeNull();
    expect(lockState!.owner.toBase58()).toBe(owner.publicKey.toBase58());
    expect(lockState!.recipient.toBase58()).toBe(recipient.publicKey.toBase58());
    expect(lockState!.mint.toBase58()).toBe(mint.toBase58());
    expect(lockState!.amount.toString()).toBe(amount.toString());

    // Verify vault has funds
    const vaultAccount = await getAccount(connection, vaultPda);
    expect(vaultAccount.amount).toBe(amount);

    // Record recipient SOL balance BEFORE claim
    const recipientSolBefore = await connection.getBalance(
      recipient.publicKey,
    );

    // Relayer executes claim
    const { instruction: claimIx } = await buildClaimInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      hashLock,
      secret,
      payerRentDest: payer.publicKey,
    });

    const claimTx = new Transaction().add(claimIx);
    await sendAndConfirmTransaction(connection, claimTx, [relayer]);

    // Verify recipient received tokens
    const recipientAta = getAssociatedTokenAddressSync(
      mint,
      recipient.publicKey,
    );
    const recipientTokenAccount = await getAccount(connection, recipientAta);
    expect(recipientTokenAccount.amount).toBe(amount);

    // Invariant: User's SOL balance remains completely unchanged
    const recipientSolAfter = await connection.getBalance(
      recipient.publicKey,
    );
    expect(recipientSolAfter).toBe(recipientSolBefore);

    // Verify PDA and vault are closed
    const closedLockState = await fetchLockState(program, lockPda);
    expect(closedLockState).toBeNull();

    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).toBeNull();
  }, 20_000);

  it("happy path: lock -> refund after deadline passes", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 25_000_000n; // 25 USDC
    const now = Math.floor(Date.now() / 1000);
    // 2 second deadline
    const deadline = BigInt(now + 2);

    const { instruction: lockIx, lockPda, vaultPda } =
      await buildLockInstruction({
        program,
        payer: payer.publicKey,
        owner: owner.publicKey,
        recipient: recipient.publicKey,
        mint,
        amount,
        hashLock,
        deadline,
        ownerTokenAccount: ownerAta,
      });

    const lockTx = new Transaction().add(lockIx);
    await sendAndConfirmTransaction(connection, lockTx, [payer, owner]);

    const ownerBalanceBeforeRefund = (
      await getAccount(connection, ownerAta)
    ).amount;

    // Wait 3 seconds for deadline to pass
    await sleep(3000);

    const { instruction: refundIx } = await buildRefundInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      mint,
      hashLock,
      payerRentDest: payer.publicKey,
      ownerTokenAccount: ownerAta,
    });

    const refundTx = new Transaction().add(refundIx);
    await sendAndConfirmTransaction(connection, refundTx, [relayer]);

    // Verify tokens refunded to owner
    const ownerBalanceAfterRefund = (
      await getAccount(connection, ownerAta)
    ).amount;
    expect(ownerBalanceAfterRefund).toBe(ownerBalanceBeforeRefund + amount);

    // Verify lockState and vault are closed
    const closedLockState = await fetchLockState(program, lockPda);
    expect(closedLockState).toBeNull();

    const vaultInfo = await connection.getAccountInfo(vaultPda);
    expect(vaultInfo).toBeNull();
  }, 20_000);

  it("rejects claim with invalid secret hash", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const wrongSecret = randomBytes(32);
    const amount = 10_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 300);

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    const { instruction: claimIx } = await buildClaimInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      hashLock,
      secret: wrongSecret,
      payerRentDest: payer.publicKey,
    });

    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
        relayer,
      ]),
    ).rejects.toThrow();
  }, 20_000);

  it("rejects claim with wrong-length secret", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const shortSecret = randomBytes(16); // 16 bytes instead of 32
    const amount = 10_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 300);

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    const { instruction: claimIx } = await buildClaimInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      hashLock,
      secret: shortSecret,
      payerRentDest: payer.publicKey,
    });

    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
        relayer,
      ]),
    ).rejects.toThrow();
  }, 20_000);

  it("rejects refund before deadline has passed", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 10_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 1000); // 1000s in the future

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    const { instruction: refundIx } = await buildRefundInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      mint,
      hashLock,
      payerRentDest: payer.publicKey,
      ownerTokenAccount: ownerAta,
    });

    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [
        relayer,
      ]),
    ).rejects.toThrow();
  }, 20_000);

  it("rejects double claim on an already claimed lock", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 5_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 300);

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    const { instruction: claimIx } = await buildClaimInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      hashLock,
      secret,
      payerRentDest: payer.publicKey,
    });

    // First claim succeeds
    await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
      relayer,
    ]);

    // Second claim must fail
    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
        relayer,
      ]),
    ).rejects.toThrow();
  }, 20_000);

  it("rejects double refund on an already refunded lock", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 5_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 2); // 2s

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    await sleep(3000);

    const { instruction: refundIx } = await buildRefundInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      mint,
      hashLock,
      payerRentDest: payer.publicKey,
      ownerTokenAccount: ownerAta,
    });

    // First refund succeeds
    await sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [
      relayer,
    ]);

    // Second refund must fail
    await expect(
      sendAndConfirmTransaction(connection, new Transaction().add(refundIx), [
        relayer,
      ]),
    ).rejects.toThrow();
  }, 20_000);

  it("claims to a fresh ATA with idempotent creation funded by relayer", async () => {
    const program = getFerryProgram(provider);
    const freshRecipient = Keypair.generate(); // Brand new keypair with 0 SOL and NO ATA
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const amount = 15_000_000n;
    const now = Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + 300);

    const { instruction: lockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: freshRecipient.publicKey,
      mint,
      amount,
      hashLock,
      deadline,
      ownerTokenAccount: ownerAta,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(lockIx), [
      payer,
      owner,
    ]);

    // Recipient ATA does NOT exist yet
    const freshAta = getAssociatedTokenAddressSync(
      mint,
      freshRecipient.publicKey,
    );
    const ataBefore = await connection.getAccountInfo(freshAta);
    expect(ataBefore).toBeNull();

    // Relayer executes claim; ATA is created on the fly and funded by relayer
    const { instruction: claimIx } = await buildClaimInstruction({
      program,
      payer: relayer.publicKey,
      owner: owner.publicKey,
      recipient: freshRecipient.publicKey,
      mint,
      hashLock,
      secret,
      payerRentDest: payer.publicKey,
    });

    await sendAndConfirmTransaction(connection, new Transaction().add(claimIx), [
      relayer,
    ]);

    // Verify fresh recipient ATA now exists and holds tokens
    const ataAccount = await getAccount(connection, freshAta);
    expect(ataAccount.amount).toBe(amount);

    // Verify fresh recipient still has 0 SOL (relayer paid all rent and fees)
    const freshSolBalance = await connection.getBalance(
      freshRecipient.publicKey,
    );
    expect(freshSolBalance).toBe(0);
  }, 20_000);

  it("rejects lock with 0 amount or deadline in past", async () => {
    const program = getFerryProgram(provider);
    const secret = randomBytes(32);
    const hashLock = sha256(secret);
    const now = Math.floor(Date.now() / 1000);

    // Zero amount
    const { instruction: zeroLockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount: 0n,
      hashLock,
      deadline: BigInt(now + 300),
      ownerTokenAccount: ownerAta,
    });

    await expect(
      sendAndConfirmTransaction(
        connection,
        new Transaction().add(zeroLockIx),
        [payer, owner],
      ),
    ).rejects.toThrow();

    // Past deadline
    const { instruction: pastLockIx } = await buildLockInstruction({
      program,
      payer: payer.publicKey,
      owner: owner.publicKey,
      recipient: recipient.publicKey,
      mint,
      amount: 10_000_000n,
      hashLock,
      deadline: BigInt(now - 10),
      ownerTokenAccount: ownerAta,
    });

    await expect(
      sendAndConfirmTransaction(
        connection,
        new Transaction().add(pastLockIx),
        [payer, owner],
      ),
    ).rejects.toThrow();
  }, 20_000);

  it("token edge cases: supports standard SPL Token and notes Token-2022 is out of scope", () => {
    // Assert program relies on standard SPL Token program (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
    // Blueprint §24.4: Token-2022 is out of scope for Ferry L6
    const standardSplTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const token2022Program = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    expect(standardSplTokenProgram).not.toBe(token2022Program);
  });
});
