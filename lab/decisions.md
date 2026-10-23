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

### D-A3-001 · S-07: CashTokens category byte order in FerryHTLC contract parameters → PASS
- **Evidence:** Live Chipnet probe on Fulcrum node (`wss://chipnet.imaginary.cash:50004`). Instance A built with display-order category parameter (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) funded in tx `72244904d3e778f606d0f264cde1e0b082abe5c762790c5b5156846b28e427d1`. Attempted claim spend was rejected by node consensus rules with `bad-txns-token-invalid-category (code 16)`. Instance B built with internal-order category parameter (`4425a0e2ca5109d0261ec0a95d1cd6ffa3c389fb4ac0b5b50cb1a4afc5ac6924` for test cat / reversed genesis hash) funded in tx `1d1d29b64fc13d76a6b859b953e4cbfc664807d139192459f94916df15e705ed`. Claim spend succeeded and was confirmed in tx `bc062c1ca46a5e9df8d2e7c66b1cf6f73cfdb8fae86f21ef054f8ce26bbccbc6`.
- **Consequence for rebuild:** The CashScript contract `FerryHTLC.cash` parameter `bytes32 tokenCategory` MUST be provided in INTERNAL (little-endian) byte order because BCH introspection opcode `OP_OUTPUTTOKENCATEGORY` pushes the internal 32 bytes onto the VM stack. `encodeHtlcParameters()` must convert RPC/display-order category hex strings to internal byte order before passing to contract constructor. Furthermore, `TransactionBuilder` and `@bitauth/libauth`'s `encodeTransactionOutput` take display-order category hex strings, which they reverse into little-endian when serializing transaction outputs.
- **Revisit if:** CashScript or CashTokens CHIP modifies introspection opcode byte order or serialization conventions.
