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
### D-A1-001 · 2026-10-22 · L0 web stack versions
- **Decision:** React 19.3.1, Vite 8.3.5, Tailwind 4.3.3, TypeScript 5.9.3, React Router 8.5.0, Vitest 5.0.5, @playwright/test 1.64.1. Exact pins in `packages/web/package.json`.
- **Evidence:** `npm view <pkg> version` on 2026-10-22 (rows in `verified-facts.md`). Blueprint §6 targets React 19 · Vite 6 · Tailwind 4. React and Tailwind majors still match. Vite 6 is two majors behind current stable; no incompatibility with the chosen React plugin appeared. TypeScript `latest` is 7.0.2, but typescript-eslint 8.72.0 declares support for `<6.1.0`, so 5.9.3 is the newest lint-compatible release (blueprint also says TS 5.x). Fontsource no longer publishes Inter Display, so Inter Variable is self-hosted; Instrument Serif is self-hosted as a latin-only italic subset.
- **Consequence for rebuild:** Resolve Vite to current stable instead of copying the blueprint number, but pin TypeScript to the newest version the lint stack supports rather than `latest`. Check `@playwright/test`'s required Chromium revision before the first e2e run.
- **Revisit if:** typescript-eslint supports TypeScript 7, a Vite 8 plugin breaks, or a design review rejects the Inter Variable look.

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

### D-A3-001 · S-07: CashTokens category byte order in FerryHTLC contract parameters → PASS
- **Evidence:** Live Chipnet probe on Fulcrum node (`wss://chipnet.imaginary.cash:50004`). Instance A built with display-order category parameter (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) funded in tx `72244904d3e778f606d0f264cde1e0b082abe5c762790c5b5156846b28e427d1`. Attempted claim spend was rejected by node consensus rules with `bad-txns-token-invalid-category (code 16)`. Instance B built with internal-order category parameter (`4425a0e2ca5109d0261ec0a95d1cd6ffa3c389fb4ac0b5b50cb1a4afc5ac6924` for test cat / reversed genesis hash) funded in tx `1d1d29b64fc13d76a6b859b953e4cbfc664807d139192459f94916df15e705ed`. Claim spend succeeded and was confirmed in tx `bc062c1ca46a5e9df8d2e7c66b1cf6f73cfdb8fae86f21ef054f8ce26bbccbc6`.
- **Consequence for rebuild:** The CashScript contract `FerryHTLC.cash` parameter `bytes32 tokenCategory` MUST be provided in INTERNAL (little-endian) byte order because BCH introspection opcode `OP_OUTPUTTOKENCATEGORY` pushes the internal 32 bytes onto the VM stack. `encodeHtlcParameters()` must convert RPC/display-order category hex strings to internal byte order before passing to contract constructor. Furthermore, `TransactionBuilder` and `@bitauth/libauth`'s `encodeTransactionOutput` take display-order category hex strings, which they reverse into little-endian when serializing transaction outputs.
- **Revisit if:** CashScript or CashTokens CHIP modifies introspection opcode byte order or serialization conventions.
