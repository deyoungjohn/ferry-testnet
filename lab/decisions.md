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

### D-A2-002 · Source exports under an explicit development condition
- **Evidence:** Core exports source under `ferry-source` before ordinary dist entries. TypeScript resolves that condition through the shared base; Vitest activates it. Ordinary Node production imports select dist.
- **Consequence for rebuild:** Vite consumers add `ferry-source` to resolve.conditions; tsx consumers launch with `--conditions=ferry-source` (or NODE_OPTIONS). Development/tests require no prior build; production builds emit dist. The root discovers package vitest.config.ts projects and excludes them from its fallback Node project, preserving each package's environment and setup.
- **Revisit if:** A consumer cannot honor export conditions; alias the source entry for development.

#### D-A2-002 verification addendum · Agent A2
- A test imports the package by name with dist temporarily absent. Vite/Vitest Node resolution additionally needs the condition in ssr.resolve.conditions; resolve.conditions alone was insufficient. Both settings are now present. The root discovers both Vitest and Vite configs in TS/MTS/JS/MJS forms, including the scripts workspace, before applying its fallback Node project.

### D-A2-003 · OrderTerms v1 multichain mapping and deterministic CBOR → PASS
- **Evidence:** Strict Zod parsing, three independent cborg-generated fixtures (forward, reverse and BSC 18 decimals), insertion-order checks, uint boundaries and tag-2 cross-checks. Deliberately encoding hashLock as text instead of bytes made all three committed golden tests fail; the mutation was restored.
- **Mapping from blueprint §3.1:**

| Blueprint field | Core v1 field and meaning |
|---|---|
| version | version remains literal 1; this is the first undeployed lab schema |
| direction | COUNTER_TO_BCH / BCH_TO_COUNTER replace EVM-specific labels |
| bchToken | Unchanged PUSD or MUSD |
| bchTokenCategory | Unchanged display-order 32-byte category |
| bchTokenAmount | Unchanged bigint base units, two decimals per blueprint |
| usdcAmount | counterAmount, bigint base units at counterAsset.decimals |
| evmChainId | counterChain is the adapter id; counterNetworkId is a positive numeric EVM id or a non-EVM network label |
| implicit USDC contract/metadata | counterAsset contains symbol USDC/USDT, integer decimals 0–36 and token address |
| evmHtlc | counterHtlc, a string address in the counter chain's format |
| userEvmAddress | userCounterAddress, string EVM hex or Solana/Tron base58 |
| solverEvmAddress | solverCounterAddress with the same representation rule |
| userBchLockingBytecode | Unchanged BCH recipient bytes |
| solverBchLockingBytecode | Unchanged BCH solver recipient bytes |
| hashLock | Unchanged 32-byte SHA-256 digest |
| evmDeadline | counterDeadline, Unix seconds for every counter-chain HTLC |
| bchRefundHeight | Unchanged absolute BCH block height, below the CLTV time threshold |
| bchCarrySats | Unchanged positive bigint satoshis |
| bchMaxFee | Unchanged nonnegative bigint satoshis, bounded by carry |
| quoteId | Unchanged bounded UTF-8 text |
| quoteExpiry | Unchanged positive integer Unix seconds |

- **Encoding decision:** Keep a small restricted encoder rather than a general CBOR data model in the runtime. Strict validation limits it to unsigned integers, byte strings, text and maps. Encode integers in the shortest form; bigint values through uint64 use normal integers, larger values use tag 2 and minimal big-endian bytes. Definite lengths only; sort map keys lexicographically by full encoded bytes per RFC 8949 §4.2.1. Hash/category/BCH script fields become bytes. Other strings remain UTF-8 text; EVM addresses and hex normalize lowercase, base58 case is retained, no Unicode normalization, invalid surrogates rejected. No float or undefined fields. cborg 6.1.4 with its standard bigIntEncoder is a dev-only independent oracle.
- **Consequence for rebuild:** Freeze this exact field mapping and profile before parallel adapter/UI work. Parse strict terms before hashing/signing; verify real route/token/deployment identities outside core. Signature helpers personal-sign exactly 32 raw digest bytes.
- **Sources:** https://www.rfc-editor.org/rfc/rfc8949.html#section-4.2.1 ; https://github.com/rvagg/cborg ; blueprint §3.1/§24.3.
- **Revisit if:** A protocol extension changes canonical fields; it then needs a new version and fixtures before deployment.

### D-A2-004 · Default probabilistic timing margins → PASS with an explicit reaction assumption
- **Method:** Model n independent exponential BCH inter-arrivals with mean 600 s as Erlang/Gamma(n, 600 s). Evaluate the integer-shape incomplete-gamma/Poisson-sum identity in the log domain and invert with bracket expansion plus 100 bisections. Independent 65-digit Python Decimal sum/bisection references and the shape-one exponential closed form verify both tails. The implementation bounds shape to 10,000 to cap CPU work.
- **Config:** SAFETY = 7200 s from the blueprint. SOLVER_REACTION = 60 s is an explicit unmeasured lab assumption because the blueprint gives no numeric value; callers can supply a measured operational bound. Reverse remaining-block minimum is 108.
- **Forward:** With 36 BCH blocks remaining and 24 h left on the counter-chain deadline at t0, P99.99 is 37612.989039 s (10.448053 h). Reaction plus safety is 7260 s. Required time is 44872.989039 s; F margin is 41527.010961 s (11.535281 h), so PASS.
- **Reverse at the minimum:** With 108 blocks remaining and a 6 h counter deadline, P0.01 is 44131.238733 s (12.258677 h). Required duration plus reaction/safety is 28860 s; R margin is 15271.238733 s (4.242011 h), so PASS. Below 108 blocks the operational gate refuses counter-locking even if the numeric margin is positive.
- **Reverse at the initial default:** With all 144 blocks remaining, P0.01 is 62150.481935 s (17.264023 h), giving 33290.481935 s (9.247356 h) margin against the same 28860 s requirement.
- **Consequence for rebuild:** Defaults pass this model with more than the claimed two-hour safety budget and the stated 60-second reaction allowance. Check actual time/height remaining at each decision, not expected block time or the original quote duration. These are tail-probability statements, not guarantees during a chain halt or a model of ASERT; the solver's halt monitoring remains mandatory. Claims can still race refunds after either deadline.
- **Source:** https://dlmf.nist.gov/8.4.E8 ; blueprint §4.1, §4.2 and §8.
- **Revisit if:** Measured solver reaction, chain behavior or confirmation policy changes.

#### D-A2-003 signing-identity addendum · Agent A2
- The EIP-191 verifier takes the trusted solver service EVM signing address from configuration. On a non-EVM route this identity is distinct from the base58 solverCounterAddress. Never accept the expected signing address from an untrusted quote. No additional signing-identity field is added to the canonical order. A separate NodeNext consumer build also verified source type resolution with declaration emission confined to the consumer's dist.
