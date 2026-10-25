import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import anchorPkg, {
  type Idl,
  type Program as ProgramType,
  type AnchorProvider as AnchorProviderType,
  type BN as BNType,
} from '@coral-xyz/anchor';
import idlJson from './ferry_htlc.json' with { type: 'json' };

const { Program, BN } = anchorPkg;

export const PROGRAM_ID = new PublicKey(
  'DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN',
);

export const FERRY_HTLC_IDL = idlJson as unknown as Idl;

export interface LockStateAccount {
  owner: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  amount: BNType;
  hashLock: number[];
  deadline: BNType;
  payer: PublicKey;
  bump: number;
}

export function getFerryProgram(provider: AnchorProviderType): ProgramType {
  return new Program(FERRY_HTLC_IDL, provider);
}

export function deriveLockPda(
  owner: PublicKey,
  hashLock: Uint8Array | number[],
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  const hashBytes = Buffer.from(hashLock);
  return PublicKey.findProgramAddressSync(
    [Buffer.from('lock'), owner.toBuffer(), hashBytes],
    programId,
  );
}

export function deriveVaultPda(
  lockPda: PublicKey,
  programId: PublicKey = PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), lockPda.toBuffer()],
    programId,
  );
}

export interface BuildLockInstructionParams {
  program: ProgramType;
  payer: PublicKey;
  owner: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  amount: bigint | number;
  hashLock: Uint8Array | number[];
  deadline: bigint | number;
  ownerTokenAccount?: PublicKey;
}

export async function buildLockInstruction(
  params: BuildLockInstructionParams,
): Promise<{
  instruction: TransactionInstruction;
  lockPda: PublicKey;
  vaultPda: PublicKey;
}> {
  const { program, payer, owner, recipient, mint, amount, hashLock, deadline } =
    params;

  const [lockPda] = deriveLockPda(owner, hashLock, program.programId);
  const [vaultPda] = deriveVaultPda(lockPda, program.programId);

  const ownerTokenAccount =
    params.ownerTokenAccount ?? getAssociatedTokenAddressSync(mint, owner);

  const hashLockArray = Array.from(hashLock);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as Record<
    string,
    (...args: unknown[]) => any
  >;

  const instruction = (await methods['lock']!(
    new BN(amount.toString()),
    hashLockArray,
    new BN(deadline.toString()),
    recipient,
  )
    .accountsStrict({
      payer,
      owner,
      mint,
      lockState: lockPda,
      vault: vaultPda,
      ownerTokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .instruction()) as TransactionInstruction;

  return { instruction, lockPda, vaultPda };
}

export interface BuildClaimInstructionParams {
  program: ProgramType;
  payer: PublicKey;
  owner: PublicKey;
  recipient: PublicKey;
  mint: PublicKey;
  hashLock: Uint8Array | number[];
  secret: Uint8Array | number[];
  payerRentDest?: PublicKey;
  recipientTokenAccount?: PublicKey;
}

export async function buildClaimInstruction(
  params: BuildClaimInstructionParams,
): Promise<{
  instruction: TransactionInstruction;
  lockPda: PublicKey;
  vaultPda: PublicKey;
}> {
  const { program, payer, owner, recipient, mint, hashLock, secret } = params;

  const [lockPda] = deriveLockPda(owner, hashLock, program.programId);
  const [vaultPda] = deriveVaultPda(lockPda, program.programId);

  const recipientTokenAccount =
    params.recipientTokenAccount ??
    getAssociatedTokenAddressSync(mint, recipient);

  const payerRentDest = params.payerRentDest ?? payer;

  const secretBuffer = Buffer.from(secret);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as Record<
    string,
    (...args: unknown[]) => any
  >;

  const instruction = (await methods['claim']!(secretBuffer)
    .accountsStrict({
      payer,
      lockState: lockPda,
      vault: vaultPda,
      recipient,
      recipientTokenAccount,
      mint,
      payerRentDest,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .instruction()) as TransactionInstruction;

  return { instruction, lockPda, vaultPda };
}

export interface BuildRefundInstructionParams {
  program: ProgramType;
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  hashLock: Uint8Array | number[];
  payerRentDest?: PublicKey;
  ownerTokenAccount?: PublicKey;
}

export async function buildRefundInstruction(
  params: BuildRefundInstructionParams,
): Promise<{
  instruction: TransactionInstruction;
  lockPda: PublicKey;
  vaultPda: PublicKey;
}> {
  const { program, payer, owner, mint, hashLock } = params;

  const [lockPda] = deriveLockPda(owner, hashLock, program.programId);
  const [vaultPda] = deriveVaultPda(lockPda, program.programId);

  const ownerTokenAccount =
    params.ownerTokenAccount ?? getAssociatedTokenAddressSync(mint, owner);

  const payerRentDest = params.payerRentDest ?? payer;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const methods = program.methods as Record<
    string,
    (...args: unknown[]) => any
  >;

  const instruction = (await methods['refund']!()
    .accountsStrict({
      payer,
      lockState: lockPda,
      vault: vaultPda,
      owner,
      ownerTokenAccount,
      mint,
      payerRentDest,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: PublicKey.default,
    })
    .instruction()) as TransactionInstruction;

  return { instruction, lockPda, vaultPda };
}

export async function fetchLockState(
  program: ProgramType,
  lockPda: PublicKey,
): Promise<LockStateAccount | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const account = await (program.account as any).lockState.fetch(lockPda);
    return account as LockStateAccount;
  } catch {
    return null;
  }
}
