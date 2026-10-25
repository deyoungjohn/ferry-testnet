# @ferry/htlc-solana

Anchor HTLC program and TypeScript client for Ferry atomic swaps on Solana.

Bitcoin Cash is the hub of all Ferry routes; this package provides the Solana endpoint for SPL token swaps (USDC / USDT) against BCH CashTokens.

## Architecture

- **Program ID (Devnet):** `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`
- **Upgrade Authority:** `none` (permanently closed on deploy via `--final`)
- **Escrow PDA:** Derived from seeds `[b"lock", owner.key().as_ref(), hash_lock.as_ref()]`
- **Vault Token Account:** PDA token account derived from seeds `[b"vault", lock_state.key().as_ref()]` with authority set to `lock_state` PDA
- **Token Scope:** Standard SPL Token Program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). Token-2022 is out of scope for Ferry L6.

### Instructions

1. `lock(amount, hash_lock, deadline, recipient)`:
   - Validates `deadline > now` and `amount > 0`.
   - Transfers tokens from owner's token account to vault PDA token account.
   - Records `payer` in `LockState` so rent lamports can be reclaimed.
   - Emits `Locked` event.

2. `claim(secret)`:
   - Checks `secret.len() == 32` and `sha256(secret) == hash_lock`.
   - Validates `recipient == lock_state.recipient`.
   - Ensures `recipient_token_account` is the canonical Associated Token Account (ATA).
   - **Idempotent ATA creation:** If the recipient does not have an ATA, the program automatically calls CPI to `associated_token::create`, funded by `payer` (relayer).
   - Transfers tokens from vault to recipient ATA via PDA signer seeds.
   - Closes vault token account and `lock_state` PDA, returning rent lamports to `payer_rent_dest` (`lock_state.payer`).
   - Emits `Claimed` event.

3. `refund()`:
   - Requires `Clock::unix_timestamp >= lock_state.deadline`.
   - Permissionless: anyone can trigger refund after the deadline.
   - Transfers tokens from vault back to owner's ATA via PDA signer seeds.
   - Closes vault and `lock_state` PDA, returning rent lamports to `payer_rent_dest`.
   - Emits `Refunded` event.

### Relayer-as-Fee-Payer (S-09 Invariant)

To enable gas-free recipient swaps on Solana:
- The transaction `feePayer` is set to the relayer.
- The relayer funds both the transaction fee and the recipient's ATA rent-exempt balance (if not already existing).
- Invariant verified on Solana Devnet: The user's native SOL balance delta is exactly **0 lamports** across the swap.

## Scripts

```bash
# Build Anchor program and extract IDL
pnpm build

# Run unit and integration tests (launches solana-test-validator locally)
pnpm test

# Typecheck TypeScript client and tests
pnpm typecheck

# Run live Solana Devnet round trip (Lock -> Claim -> Refund)
pnpm run roundtrip:devnet
```
