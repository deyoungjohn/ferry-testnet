# @ferry/chain-tron

Tron network `ChainAdapter` implementation for Ferry atomic swaps (TRC-20 USDT against BCH CashTokens).

## Overview

- Implements the `@ferry/core` `ChainAdapter` interface for Tron.
- Handles TRC-20 approve + lock preparation (`buildUserLock`) without EIP-2612 permit (`D-A3-006`).
- Deterministic and collision-resistant `lockId(owner, hashLock)` derivation matching on-chain `FerryHTLC.sol`.
- Solidified finality policy per blueprint §24.2 (`isFinal`: fast lane = 1 confirmed block, safe lane = solidified block ~19 blocks / ~57s).
- Comprehensive event watcher (`watch`) tracking `Locked`, `Claimed`, and `Refunded` events with polling backstop.
- Energy and bandwidth relay fee estimation (`estimateRelayCostUsd`).

## Testing & Hermetic Rule

Hermetic test rule: Tests must be hermetic; any artifact required by tests must be compiled as part of the test script or checked in (the sequence `pnpm install` then `pnpm test` without an intermediate build step must always succeed).

- Default `pnpm test`: Fast offline test suite verifying adapter initialization, address format handling, lockId derivation, finality evaluation, user lock construction, event decoding, and fee estimation without requiring network access or external services.
- Opt-in Nile testnet integration: Configurable with `NILE_PRIVATE_KEY` to run against live TRON Nile testnet contracts.
