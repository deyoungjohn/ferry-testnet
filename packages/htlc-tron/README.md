# @ferry/htlc-tron

TRON TVM HTLC contract (`FerryHTLC.sol`) and TypeScript testing harness for Ferry atomic swaps on TRON (USDT TRC-20 against BCH CashTokens).

## Overview

- Implements hashed timelock contract for TRON TVM.
- **TVM-Safe Token Transfer (`SafeTRC20`):** Natively handles TRON USDT's non-standard return quirk (void return in TVM pads with 32 zero bytes) as well as standard TRC-20 tokens returning boolean `true`.
- **Approve + Lock Flow:** Dropped `lockWithIntent` (`D-A3-006`) as TRC-20 USDT does not support EIP-2612 permit.

## Testing & Hermetic Rule

Hermetic test rule: Tests must be hermetic; any artifact required by tests must be compiled as part of the test script or checked in (the sequence `pnpm install` then `pnpm test` without an intermediate build step must always succeed).

```bash
# Run unit tests (compiles required Forge artifacts hermetically)
pnpm test

# Build Solidity contracts with Forge and TronBox
pnpm build

# Typecheck and lint
pnpm typecheck
pnpm lint
```
