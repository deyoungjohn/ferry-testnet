# @ferry/scripts

Workspace management scripts and key derivation utilities for Ferry.

## Overview

- `scripts/keys/`: Deterministic testnet key generation and address inspection for BCH, EVM, Solana, and TRON.
- `scripts/balances/`: Multi-chain balance checker across testnet roles (Deployer, Solver, User).
- `scripts/fulcrum/`: Fulcrum WebSocket connection probe for Bitcoin Cash Chipnet.

## Testing & Hermetic Rule

Hermetic test rule: Tests must be hermetic; any artifact required by tests must be compiled as part of the test script or checked in (the sequence `pnpm install` then `pnpm test` without an intermediate build step must always succeed).

```bash
# Run tests
pnpm test

# Typecheck and lint
pnpm typecheck
pnpm lint
```
