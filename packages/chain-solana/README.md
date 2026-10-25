# @ferry/chain-solana

Solana chain adapter for Ferry (`ChainAdapter` interface implementation).

## Overview

- Implements `@ferry/core`'s `ChainAdapter` interface for Solana.
- Interacts with Anchor 1.2.1 program `ferry_htlc` (`DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`).
- Decoupled network and token configurations with presets for `devnet`, `mainnet`, and `localnet`.
- Provides relayer-assisted gasless flow for users (`buildUserLock`, `relayLock` with relayer fee-payer).
- Browser-safe for `buildUserLock` and `getLock` without requiring private keys.
- Implements `lock`, `claim`, `refund`, `getLock`, `watch` (WebSocket subscription + polling backstop with stable event IDs), `isFinal` (`confirmed` for fast lane, `finalized` for safe lane), and `estimateRelayCostUsd`.

## Network Configuration & Token Mints

The adapter is configured via `SolanaAdapterConfig`:
- `network`: `'devnet' | 'mainnet' | 'localnet'` (defaults to `'devnet'`)
- `rpcUrl`: Solana RPC endpoint URL (e.g. `https://api.devnet.solana.com`)
- `wsUrl`: Optional WebSocket endpoint
- `programId`: Program public key (defaults to `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`)
- `assets`: Mapping of asset symbols (`USDC`, `USDT`) to mint public keys, or individual `usdcMint`/`usdtMint` overrides.

Default mints:
- **Devnet**:
  - `USDC`: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`
- **Mainnet**:
  - `USDC`: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
  - `USDT`: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`

## Testing

The test suite is partitioned into two tiers:

1. **Offline default tests** (`pnpm test`):
   Runs pure unit tests and offline adapter verification without spawning any local services or contacting the network. Runs in <1 second.
   ```bash
   pnpm --filter @ferry/chain-solana test
   ```

2. **Validator integration tests** (`pnpm test:validator`):
   Runs on-chain round-trip tests against a local `solana-test-validator` instance (configured for Port 8899/8900). Requires Solana CLI tools and the compiled `ferry_htlc.so` program.
   ```bash
   pnpm --filter @ferry/chain-solana test:validator
   ```
