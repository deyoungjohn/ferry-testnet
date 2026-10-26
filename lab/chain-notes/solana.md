# Chain notes — solana

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

## 2026-10-25 · L6 Solana Anchor Program & Devnet Verification

### 1. Toolchain & Anchor Build Times
- Tools used: `anchor-cli 1.2.1` (`anchor-lang 1.2.1`, `anchor-spl 1.2.1`), `solana-cli 4.1.2` (Agave), `cargo-build-sbf 4.1.0`, `platform-tools v1.54`.
- Host system: Ubuntu 24.04 on WSL2 (12 GB RAM, 6 vCPUs).
- Build timings:
  - Initial cold compilation of SBPF dependencies and Anchor IDL extraction: ~2 minutes 19 seconds.
  - Subsequent incremental rebuilds: ~2.7 seconds (`anchor build`).
  - SBPF binary size for `ferry_htlc.so`: 268,128 bytes (0x41760 bytes).

### 2. Program Architecture & PDA Design
- Escrow PDA seeds: `[b"lock", owner.as_ref(), hash_lock.as_ref()]`.
- Vault token account: PDA token account with seeds `[b"vault", lock_state.key().as_ref()]`, authority = `lock_state` PDA.
- Rent funding and reclaim: the `lock` instruction records `payer` in `LockState`. Both `claim` and `refund` require `payer_rent_dest == lock_state.payer`, closing both the vault token account and the `lock_state` PDA, returning all lamports back to the original funding account.
- Idempotent recipient ATA creation: in `claim`, if the recipient's Associated Token Account does not exist on-chain, the program CPI calls `associated_token::create`, funded by `payer` (relayer). This guarantees the swap completes even if the recipient has never held SPL tokens or SOL.

### 3. S-09 Verification: Relayer-as-Fee-Payer & SOL Invariant
- Tested locally on `solana-test-validator 4.1.2` across 10 unit and integration tests (happy path lock/claim, lock/refund, invalid secret hash, invalid secret length, too early refund, double claim rejection, double refund rejection, fresh ATA creation, zero amount rejection).
- Devnet deployment:
  - Program ID: `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`
  - Deploy signature: `4uPzwMzSiRB9whuQPwygCq9wWXNcMhB7AVQ6uEfp4LhXsVVpKpXkA5nY57Rk5YHARAzzhvzP2M85QhbCGdAJW2rJ`
  - Deployment rent: 1.36296908 SOL.
  - Immutability: upgrade authority closed via `solana program set-upgrade-authority DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN --final`. Verified on-chain that Authority is `none`.
- Devnet Round Trips (Mock USDC 6-decimals, Mint `8KKPJt2u93nHbXGPNxV8fjHnWWt5JUAWWUoYqkNmo8Ht`):
  - Lock tx: `MYNkVANbXZeEzr1xLrzWZezUTPt4iaoNTMASqDwKNz4pM7ofouULL5cbY1JZykTF4YYMK4his6zGQr7btWTBsz7` (fee: 5,000 lamports, confirmation: 3.90 s).
  - Claim tx (relayed): `5CbB8CwyZ5eVPFhuF5343JEQ8dcENTm1GPev75Bf6gobTUTyX4qFDUP2XE9fRV83qF3zNax9gqpAvqqScaH1H9jc` (fee: 5,000 lamports, confirmation: 1.09 s).
  - User SOL balance before claim: `1,000,000,000` lamports.
  - User SOL balance after claim: `1,000,000,000` lamports.
  - User SOL delta: exactly `0` lamports (S-09 criteria PASSED).
  - Refund Lock tx: `4RzsZiCbYeEgtjmqagkTNHS2MwTig8GPWEJQ4A2ptr9XiWDN3GYuuTxbHx5z7yt45VgafPUJ8Lj3Mp6wxZVbMuR5`.
  - Refund tx: `res1xMT3FqvuuYTs2dQ9kQ9vsZyz4du4oQt9eZq9BBzgfSAKBqCtns7WEkZFUwnY1YsibHjbUit8TtMeaCbY3UC` (fee: 5,000 lamports, confirmation: 1.86 s).
  - Escrow PDAs closed and rent refunded: verified `fetchLockState` returns null after claim and refund.

### 4. Real-Token Quirks & Token-2022 Boundary
- Circle Devnet USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (decimals: 6). Automated requests from the CLI were blocked by Cloudflare turnstile protection on the Circle faucet. A mock 6-decimal SPL mint was deployed for automated verification.- Token-2022: Per blueprint section 24.4, Token-2022 transfer-hook and confidential transfer extensions are out of scope for Ferry L6. The contract binds to standard SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`).

### 5. Program Keypair, Clean-Clone Builds & Anchor Mismatch Warning
- The deployed devnet program ID is `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`. The deploy transaction was signed by the deployer keypair configured in `.env.local` (`FERRY_SOL_KEY` / `DEPLOYER_SOL_KEY`), kept outside git per §7.3. Its upgrade authority was permanently closed via `solana program set-upgrade-authority ... --final`.
- On a fresh clone without `target/deploy/ferry_htlc-keypair.json`, `anchor build` automatically generates a random keypair in `target/deploy/` and emits:
  `WARNING: Program ID mismatch: Program declared in src/lib.rs (DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN) does not match keypair in target/deploy/ferry_htlc-keypair.json (...)`
- **Rebuild Rule:** `anchor build` exits 0 despite this warning. Developers and CI builds that do not deploy must ignore this warning. **Never run `anchor keys sync`** on a clean clone, as doing so rewrites `declare_id!` in `programs/ferry_htlc/src/lib.rs` and `Anchor.toml`, mutating tracked git files and disconnecting from the devnet deployment.
- Re-deployments to any target network must specify the explicit program keypair path:
  `anchor deploy --program-keypair <path-to-keypair.json>` (or `solana program deploy <binary.so> --program-id <path-to-keypair.json>`).

---

## 2026-10-26 · Live Circle Devnet USDC Round-Trip Execution (S-09 Verified)

### Live Round Trips with Official Circle Devnet USDC
- **Token Mint:** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Official Circle Devnet USDC, 6 decimals).
- **Program ID:** `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`.
- **Round Trip 1: Solver Lock -> User Claim (Relayed):**
  - Solver Lock Tx: `5YVAGEF4GB2wFh7oBB1RzoercsXDc1T8Cq1thQD39iFRZK76L4hmaaEyArzSiwxaHrzjt8gqyxTXVXAzFif6u5mG` (fee: 5,000 lamports, confirmation: 1,775 ms).
  - LockState confirmed: owner `ErGkftKbKE8pKFn2PYWGsuizBw9b8JKPkAhLFv4KqudS`, recipient `7qRHmL8MXZS2ZwWKbUe4P43F6Bas9aL4eJxPAzptyY4v`, amount 5,000,000 (5 USDC).
  - User SOL balance before claim: 999,990,000 lamports.
  - Relayed User Claim Tx: `2v3BHXgrLZuH2UepV11BoKTauXp1Wp4DVBeZ4QEkTfwkeemeUj1B7qKhT2L2xC9G9Z9czaZinAVTZsLHqb9S1pV5` (fee: 5,000 lamports paid by Deployer/Relayer, confirmation: 1,358 ms).
  - User SOL balance after claim: 999,990,000 lamports.
  - User SOL Delta: exactly **0 lamports** (S-09 Invariant preserved with real Circle token).
  - LockState account closed on devnet: YES (null).
- **Round Trip 2: User Lock -> Refund After Deadline:**
  - User Lock Tx: `2rC9PdyMxYoPeikP61jGmKJcZH3qKULYqgWe2dpbYNYAdfmrhjTuMx81ou1BYZfMAkK7N8vy6E9xQ3oHHTBA3W2X`.
  - Refund Tx: `5oxmjxBXqnNStD9K6h446RExhPUSCu3Ayt4aKJiTZmDC3LT9fq46ctMV9KpBSete2mHSZNKfM1F87hSoKsE7FSV1` (fee: 5,000 lamports, confirmation: 1,892 ms).
  - Refunded Amount: 2,000,000 (2 USDC) returned to user.
  - Refund LockState account closed on devnet: YES (null).

