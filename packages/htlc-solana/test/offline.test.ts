import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import anchorPkg from '@coral-xyz/anchor';
const { AnchorProvider, Wallet } = anchorPkg;
import {
  PROGRAM_ID,
  getFerryProgram,
  deriveLockPda,
  deriveVaultPda,
  buildLockInstruction,
  buildClaimInstruction,
  buildRefundInstruction,
} from '../src/index.js';

describe('offline Solana HTLC client & artifact checks', () => {
  const pkgDir = resolve(__dirname, '..');

  it('verifies PROGRAM_ID matches Anchor.toml and program lib.rs declaration', () => {
    const anchorTomlPath = resolve(pkgDir, 'Anchor.toml');
    const anchorToml = readFileSync(anchorTomlPath, 'utf8');
    expect(anchorToml).toContain(`ferry_htlc = "${PROGRAM_ID.toBase58()}"`);

    const libRsPath = resolve(pkgDir, 'programs/ferry_htlc/src/lib.rs');
    const libRs = readFileSync(libRsPath, 'utf8');
    expect(libRs).toContain(`declare_id!("${PROGRAM_ID.toBase58()}");`);
  });

  it('verifies IDL artifact integrity and consistency', () => {
    const srcIdlPath = resolve(pkgDir, 'src/ferry_htlc.json');
    expect(existsSync(srcIdlPath)).toBe(true);

    const srcIdl = JSON.parse(readFileSync(srcIdlPath, 'utf8'));
    expect(srcIdl.metadata?.name).toBe('ferry_htlc');
    expect(srcIdl.instructions).toBeDefined();

    const instructionNames = srcIdl.instructions.map(
      (ix: { name: string }) => ix.name,
    );
    expect(instructionNames).toContain('lock');
    expect(instructionNames).toContain('claim');
    expect(instructionNames).toContain('refund');

    // If target/idl/ferry_htlc.json exists, ensure src matches target
    const targetIdlPath = resolve(pkgDir, 'target/idl/ferry_htlc.json');
    if (existsSync(targetIdlPath)) {
      const targetIdl = JSON.parse(readFileSync(targetIdlPath, 'utf8'));
      expect(srcIdl.instructions).toEqual(targetIdl.instructions);
      expect(srcIdl.accounts).toEqual(targetIdl.accounts);
    }
  });

  it('derives lock PDA deterministically with canonical bump', () => {
    const owner = Keypair.generate().publicKey;
    const hashLock = new Uint8Array(32).fill(0xab);

    const [lockPda, bump] = deriveLockPda(owner, hashLock);
    expect(lockPda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);

    // Deterministic re-derivation
    const [lockPda2, bump2] = deriveLockPda(owner, hashLock);
    expect(lockPda.toBase58()).toBe(lockPda2.toBase58());
    expect(bump).toBe(bump2);
  });

  it('derives vault PDA deterministically from lock PDA', () => {
    const owner = Keypair.generate().publicKey;
    const hashLock = new Uint8Array(32).fill(0xcd);
    const [lockPda] = deriveLockPda(owner, hashLock);

    const [vaultPda, bump] = deriveVaultPda(lockPda);
    expect(vaultPda).toBeInstanceOf(PublicKey);
    expect(bump).toBeGreaterThanOrEqual(0);
    expect(bump).toBeLessThanOrEqual(255);

    // Deterministic re-derivation
    const [vaultPda2, bump2] = deriveVaultPda(lockPda);
    expect(vaultPda.toBase58()).toBe(vaultPda2.toBase58());
    expect(bump).toBe(bump2);
  });

  it('enforces collision resistance across distinct owners and hashLocks', () => {
    const owner1 = Keypair.generate().publicKey;
    const owner2 = Keypair.generate().publicKey;
    const hash1 = new Uint8Array(32).fill(0x01);
    const hash2 = new Uint8Array(32).fill(0x02);

    const [pdaOwner1Hash1] = deriveLockPda(owner1, hash1);
    const [pdaOwner2Hash1] = deriveLockPda(owner2, hash1);
    const [pdaOwner1Hash2] = deriveLockPda(owner1, hash2);

    expect(pdaOwner1Hash1.toBase58()).not.toBe(pdaOwner2Hash1.toBase58());
    expect(pdaOwner1Hash1.toBase58()).not.toBe(pdaOwner1Hash2.toBase58());

    const [vault1] = deriveVaultPda(pdaOwner1Hash1);
    const [vault2] = deriveVaultPda(pdaOwner2Hash1);
    expect(vault1.toBase58()).not.toBe(vault2.toBase58());
  });

  it('builds lock instruction offline with correct accounts and signer flags', async () => {
    const dummyProvider = new AnchorProvider(
      {} as never,
      new Wallet(Keypair.generate()),
      {},
    );
    const program = getFerryProgram(dummyProvider);

    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const hashLock = new Uint8Array(32).fill(0x42);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const amount = 1_000_000n;

    const { instruction, lockPda, vaultPda } = await buildLockInstruction({
      program,
      payer,
      owner,
      recipient,
      mint,
      amount,
      hashLock,
      deadline,
    });

    expect(instruction.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(instruction.keys.length).toBe(8);

    const payerMeta = instruction.keys.find((k) => k.pubkey.equals(payer));
    expect(payerMeta?.isSigner).toBe(true);
    expect(payerMeta?.isWritable).toBe(true);

    const ownerMeta = instruction.keys.find((k) => k.pubkey.equals(owner));
    expect(ownerMeta?.isSigner).toBe(true);
    expect(ownerMeta?.isWritable).toBe(false);

    const lockMeta = instruction.keys.find((k) => k.pubkey.equals(lockPda));
    expect(lockMeta?.isSigner).toBe(false);
    expect(lockMeta?.isWritable).toBe(true);

    const vaultMeta = instruction.keys.find((k) => k.pubkey.equals(vaultPda));
    expect(vaultMeta?.isSigner).toBe(false);
    expect(vaultMeta?.isWritable).toBe(true);
  });

  it('builds claim instruction offline with relayer as fee-payer (recipient not signer)', async () => {
    const dummyProvider = new AnchorProvider(
      {} as never,
      new Wallet(Keypair.generate()),
      {},
    );
    const program = getFerryProgram(dummyProvider);

    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const hashLock = new Uint8Array(32).fill(0x55);
    const secret = new Uint8Array(32).fill(0x77);

    const { instruction, lockPda, vaultPda } = await buildClaimInstruction({
      program,
      payer,
      owner,
      recipient,
      mint,
      secret,
      hashLock,
    });

    expect(instruction.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(instruction.keys.length).toBe(10);

    const payerMeta = instruction.keys.find((k) => k.pubkey.equals(payer));
    expect(payerMeta?.isSigner).toBe(true);
    expect(payerMeta?.isWritable).toBe(true);

    // Recipient is not a signer (relayer executes claim on recipient behalf)
    const recipientMeta = instruction.keys.find((k) =>
      k.pubkey.equals(recipient),
    );
    expect(recipientMeta?.isSigner).toBe(false);
    expect(recipientMeta?.isWritable).toBe(false);

    const lockMeta = instruction.keys.find((k) => k.pubkey.equals(lockPda));
    expect(lockMeta?.isWritable).toBe(true);

    const vaultMeta = instruction.keys.find((k) => k.pubkey.equals(vaultPda));
    expect(vaultMeta?.isWritable).toBe(true);
  });

  it('builds refund instruction offline with payer as signer', async () => {
    const dummyProvider = new AnchorProvider(
      {} as never,
      new Wallet(Keypair.generate()),
      {},
    );
    const program = getFerryProgram(dummyProvider);

    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const hashLock = new Uint8Array(32).fill(0x99);

    const { instruction, lockPda, vaultPda } = await buildRefundInstruction({
      program,
      payer,
      owner,
      mint,
      hashLock,
    });

    expect(instruction.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(instruction.keys.length).toBe(10);

    const payerMeta = instruction.keys.find((k) => k.pubkey.equals(payer));
    expect(payerMeta?.isSigner).toBe(true);
    expect(payerMeta?.isWritable).toBe(true);

    const ownerMeta = instruction.keys.find((k) => k.pubkey.equals(owner));
    expect(ownerMeta?.isWritable).toBe(false);

    const lockMeta = instruction.keys.find((k) => k.pubkey.equals(lockPda));
    expect(lockMeta?.isWritable).toBe(true);

    const vaultMeta = instruction.keys.find((k) => k.pubkey.equals(vaultPda));
    expect(vaultMeta?.isWritable).toBe(true);
  });
});
