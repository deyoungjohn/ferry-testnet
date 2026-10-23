# Decisions

Lightweight decision records (template below). Spike answers (S-01…S-14, Q-A…Q-C) go here as pass/fail plus the consequence for the rebuild. IDs: `D-A<n>-<nnn>` (agents), `D-OR-<nnn>` (maintainer). Append-only.

---

### Branch-per-task worktrees, merge commits, merges by the maintainer
- **Evidence:** Three agents work in parallel in the same phase; history doubles as the timing record.
- **Consequence for rebuild:** Use `ph<n>-<slug>` branches in sibling worktrees; merge PRs with merge commits (not squash) so per-commit timings survive.
- **Revisit if:** Review becomes the bottleneck (then consider a 4th agent or batching PRs).

### D-A2-001 · Pin pnpm 9 through packageManager → PASS
- **Evidence:** `npm view pnpm versions` and `npm view pnpm@9 version` confirm 9.15.9 as the latest 9.x release; both `corepack pnpm --version` and the existing pnpm launcher return 9.15.9 inside this workspace. Outside it the installed pnpm remains 12.8.1. A temporary clean clone passes install, build, typecheck, lint and tests with the v9 lockfile.
- **Consequence for rebuild:** Keep the blueprint's major and pin `pnpm@9.15.9` in `packageManager`; use Corepack when the shell launcher does not honor that field. Enable exact saves and engine checks in `.npmrc`. Node is already managed by NVM, so pin its installed 22.23.1 in `.nvmrc` and avoid installing a second version manager.
- **Revisit if:** A future dependency demonstrably requires a newer pnpm major, or the frozen hackathon toolchain is deliberately reverified.

### Package boundaries for chain-specific code, plus cross-agent test vectors
- **Evidence:** Blueprint §5.5 puts BCH script helpers and EVM helpers inside `@ferry/core`, but in the lab three agents build core, the BCH contract and the EVM contract in parallel. Shared ownership of `core/bch` and `core/evm` would serialise them.
- **Consequence for rebuild:** `@ferry/core` holds chain-agnostic protocol logic only: order terms, canonical encoding, `orderId`, signing, pricing, timing, reveal policy, the `ChainAdapter` interface, plus the EIP-712 `LockIntent` typed-data definition and EVM `lockId` derivation (needed by both web and solver). Script-specific code lives with its contract: `@ferry/htlc-bch` (artifact, parameter encoding, P2SH32 derivation, spend builders, category byte order) and `@ferry/htlc-evm` (ABI export, deploy scripts). Where two agents implement the same rule in two languages, both compute a shared cross-check vector (`XV-nnn`, defined in the prompts); the maintainers compares the results before merging.
- **Revisit if:** In the hackathon a single person owns core and both contracts; then the §5.5 layout is fine.

### D-A1-002 · Dynamic EIP-712 domain separator instead of an immutable
- **Decision:** `FerryHTLC.DOMAIN_SEPARATOR()` is a view function that hashes `EIP712Domain(name, version, block.chainid, address(this))`; it is not a constructor-set immutable.
- **Evidence:** Blueprint §5.2 stores the separator in an immutable. That makes the XV-003 fixed-address check impossible without a real deployment at `0x1111…`, and it would keep a stale chain id after a fork. The dynamic form is the OpenZeppelin `EIP712` behaviour and still exposes the same `DOMAIN_SEPARATOR()` ABI.
- **Consequence for rebuild:** Use a dynamic separator unless gas profiling shows it matters; the extra hashing is confined to `lockWithIntent`.
- **Revisit if:** A consumer needs a `view`-free constant, or a fork test shows a chain-id migration problem.

### D-A1-003 · SignatureChecker (ECDSA + ERC-1271) for the lock intent
- **Decision:** `lockWithIntent` validates the intent with OpenZeppelin `SignatureChecker.isValidSignatureNow`, not `ECDSA.recover`.
- **Evidence:** S-06 uses an EOA wallet, but smart-contract wallets are common on Base and a relayer flow should not exclude them. `SignatureChecker` accepts both a 65-byte ECDSA signature and an ERC-1271 `isValidSignature` response; the mock smart wallet test exercises the latter. The intent digest and replay protection are unchanged.
- **Consequence for rebuild:** Keep `SignatureChecker`; the permit step may fail for a smart wallet and is caught, so the wallet must already have approved the exact amount.
- **Revisit if:** The extra ERC-1271 staticcall is unacceptable on a hot path, or a wallet implementation returns a non-standard magic value.

### D-A1-004 · Checks-effects-interactions ordering in `lockWithIntent`
- **Decision:** Validate the intent and signature first, then create the lock state and emit `Locked`, then attempt the permit, then pull the tokens. The blueprint attempts the permit before `_lock`.
- **Evidence:** This ordering keeps state and the event ahead of both token interactions, and `nonReentrant` blocks any callback from `permit`. Moving the permit before the lock would leave a token callback able to reenter before the lock existed; it also risked consuming a permit nonce on an invalid term. Tests cover a front-run permit, an expired permit with an existing allowance, and replay.
- **Consequence for rebuild:** Keep CEI ordering; the permit call must still happen before `safeTransferFrom`.
- **Revisit if:** A permit implementation needs to run before any state write for a token-specific reason.

### D-A1-005 · OpenZeppelin 5.6.1 from the npm registry
- **Decision:** Pin `@openzeppelin/contracts` to `5.6.1` in `packages/htlc-evm/package.json`; pnpm records the tarball integrity in `pnpm-lock.yaml`.
- **Evidence:** On 2026-10-22 the npm `latest` dist-tag is `5.6.1`; `5.7.0` is published under `dev`. The prompt asks for an exact current 5.x release and a pinned tag or commit. The registry release is immutable and integrity-checked, and avoids a git submodule/root `.gitmodules` change.
- **Consequence for rebuild:** Use the registry tarball with an exact version and lockfile; do not use a floating tag. Re-check the current stable 5.x before the event.
- **Revisit if:** A needed fix exists only on the `dev` tag, or the review requires a git tag/commit instead of a registry tarball.

### D-A1-006 · `via_ir` for the Solidity build
- **Decision:** Compile with `via_ir = true` and the optimizer enabled.
- **Evidence:** Without IR, solc 0.8.28 reports stack-too-deep at the 12-argument `lockWithIntent` boundary. The IR pipeline compiles in about 1 second locally and leaves more stack headroom; the ABI is unchanged and the deterministic address is recomputed from the final artifact.
- **Consequence for rebuild:** Keep `via_ir` while the public signature stays wide; if the ABI is refactored to structs, retest without IR. Slither and forge inspect the resulting bytecode/IR normally.
- **Revisit if:** A tool in the deployment or verification path cannot handle IR-compiled metadata, or gas regresses materially.
