# @ferry/chain-solana

Solana chain adapter for Ferry (`ChainAdapter` interface implementation).

## Overview

- Implements `@ferry/core`'s `ChainAdapter` interface for Solana.
- Interacts with Anchor 1.2.1 program `ferry_htlc` (`DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`).
- Provides relayer-assisted gasless flow for users (`buildUserLock`, `relayLock` with relayer fee-payer).
- Browser-safe for `buildUserLock` and `getLock` without requiring private keys.
- Implements `lock`, `claim`, `refund`, `getLock`, `watch` (WebSocket subscription + polling backstop with stable event IDs), `isFinal` (`confirmed` for fast lane, `finalized` for safe lane), and `estimateRelayCostUsd`.
