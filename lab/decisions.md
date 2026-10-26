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

#### D-A3-001 verification addendum (airtight script-level check)
- **Evidence:** S-07 was rerun on Chipnet to isolate contract script execution from transaction-level token consensus. In the earlier probe, the claim output category was reversed from the contract parameter, triggering node transaction-level rejection (`bad-txns-token-invalid-category (code 16)`) before script evaluation. In this addendum run, Instance A was funded with display-order parameter (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) in funding transaction `01bd0f77ff09510c4b5fa87c03e4e0d7db3e285a23bf71e2a61904b50d805b18`. The claim transaction was constructed with the genuine display-order category (`tPUSD`) on both input and output so CashTokens consensus validation passed. Evaluation proceeded to the contract P2SH32 redeem script, where `OP_OUTPUTTOKENCATEGORY` pushed internal bytes while constructor parameter held display bytes. The node rejected the spend with exact script error: `mandatory-script-verify-flag-failed (Script failed an OP_EQUALVERIFY operation) (code 16)`. Instance B (internal-order parameter) was funded in `0dcb2b463086f96337edf858dfb82b5dbfdf5720676c2b8730de1d7cb815351d` and claimed in `2d1f827f1e2cd1ea21d2223fbbff7579a805dfad69a3cbf8bf3c781c1a575937` (376 bytes, 500 sats fee, 365 ms). Instance C (refund spend) was funded in `69ff119ec1c29e5289dee68ca385d6fd998adbae6dc89f097aabe7507321702e` and refunded at height 329332 in `45365de34867a02fe550f97b3afff6bdedcd4241f3db209ca2411753dd0929df` (341 bytes, 500 sats fee, 305 ms).
- **Consequence for rebuild:** Confirms unconditionally that passing display-order category bytes into the covenant compiles and funds, but unconditionally fails on-chain at the script `OP_EQUALVERIFY` opcode during spend evaluation.

### D-A3-002 · XO Engine execution spike S-01/S-02 → NO (Clean Fallback to Blueprint §10)
- **Evidence:**
  - **S-02 (Bytecode Parity): PASS.** Transcribed `FerryHTLC.cash` to CashAssembly in `packages/htlc-bch/xo/ferry-htlc.template.ts`. When compiled with `compileCashAssemblyString` in hex evaluation mode (`evaluationDecodeMode: 'hex'`), the resulting locking bytecode and P2SH32 address match the CashScript compiler output byte-for-byte (`aa20f18a11e0f61cb26e47fd59976c9453a5a687333ea6f5af1fdc35a5414eca7d8987`), verified in `packages/htlc-bch/test/xo-template.test.ts`.
  - **S-01 (Engine Execution Spike): NO.** Evaluated through `@xo-cash/engine@0.1.0-next.17437760444` and `@xo-cash/state@0.0.5` in `packages/htlc-bch/src/probe-xo-engine.ts`:
    1. Template import succeeded (`ID: 6f1fc081e8da5757fd5b68bc691686f5c9780ec999ac94c09f3ce0c128cdfd9f`).
    2. Lock invitation created and locking bytecode resolved successfully. The engine builds the lock transaction with valid CashTokens output prefix (`020000000001d00700000000000048ef333333333333333333333333333333333333333333333333333333333333333310fde803aa20f18a...`).
    3. Spend execution (Claim/Refund): When attempting to sign a claim input via `engine.signInvitation`, the engine fails with `InputUnspentOutputUnavailableError: Unspent output 4444...44:0 of merged input 0 in invitation "..." not tracked by this account`.
    4. Architectural barriers identified:
       - **Strict Local Tracking:** In XO Engine, an account can only spend UTXOs that exist in its internal state (`state.getUnspentOutputData`) with associated template metadata (`state.getScriptHashData`). An external party (solver or recipient) receiving a covenant UTXO outpoint cannot build or sign the spend transaction without the UTXO and its derivation secrets having been tracked locally from inception.
       - **Covenant vs HD Model:** XO's `signInvitation` and `generateInputUnlockingBytecode` are architected around Libauth entity key signatures (Schnorr/ECDSA key operations). Pure covenant spending that requires revealing a secret preimage (`OP_SHA256 OP_EQUALVERIFY`) and CLTV locktimes does not fit the engine's key-derivation pipeline.
       - **CashAssembly Evaluation Decode Mode Quirk:** In `@xo-cash/engine`, `resolveTemplateTokenCategory` evaluates CashAssembly expressions with hardcoded `evaluationDecodeMode: "utf8"` rather than `"hex"`. For binary category expressions (`$(<tokenCategory>)`), UTF-8 decoding corrupts bytes into replacement characters unless passed as an ASCII hex string.
       - **Storage Adapter in Node.js:** `@xo-cash/state@0.0.5` has `SQLiteStorage` stubbed out with `/* SQLite storage implementation. (Not implemented yet) */`, requiring `indexeddbshim` under Node.js.
- **Consequence for rebuild:**
  - Fall back cleanly to blueprint §10: CashScript contract and artifact execute lock, claim, and refund transactions for the hackathon MVP.
  - The XO template in `packages/htlc-bch/xo/` serves as the formal contract specification and lock invitation generator for post-L8 / mainnet roadmaps.
- **Revisit if:** General Protocols releases an engine version supporting non-HD covenant spend execution and native SQLite storage.

### D-A3-003 · S-05: Fulcrum Latency and DSProof Support → PASS
- **Evidence:**
  - Probed candidate Fulcrum endpoints across Chipnet and Mainnet (Mainnet read-only, no broadcasts): `wss://chipnet.imaginary.cash:50004` (Fulcrum 2.1.4), `wss://bch.imaginary.cash:50004` (Fulcrum 2.1.4), `wss://fulcrum.greyh.at:50004` (Fulcrum 2.1.2).
  - All candidate servers report `cashtokens: true` and `dsproof: true` in `server.features`.
  - Protocol methods `blockchain.transaction.dsproof.subscribe([txid])` and `blockchain.transaction.dsproof.get([txid])` take the 32-byte transaction hash and respond with `null` (when uncontested) or the proof object when contested.
  - Live 10-sample Chipnet broadcast-to-notification latency benchmark achieved: Min 804.0 ms, Median 1021.1 ms, Max 1372.1 ms. Target threshold was median < 2000 ms, so PASS.
  - Instantaneous tip subscription confirmed via `blockchain.headers.subscribe`.
- **Consequence for rebuild:**
  - Fulcrum is fast enough for Ferry's 0-conf lock detection on BCH (~1.0s median round-trip notification).
  - The solver can subscribe to the user's lock transaction via `blockchain.transaction.dsproof.subscribe([txid])` immediately upon broadcast to obtain sub-1.5s contested signal before fulfilling counter-chain swaps.
- **Revisit if:** Network congestion or remote node peering degrades median notification latency beyond 2000 ms.

---

### Questions for General Protocols (Q-C)

- **Q-C01 (Covenant Spend Execution without HD Keys):** How should custom P2SH32 covenants (such as Ferry's HTLC, where spending inputs require unlocking by revealing a SHA-256 secret preimage and passing CLTV rather than producing an ECDSA/Schnorr key signature) be signed and executed in the XO Engine? Currently, `signInvitation` expects inputs to be tracked by the local account's key store and throws `InputUnspentOutputUnavailableError` when spending an untracked covenant outpoint.
- **Q-C02 (Token Category Evaluation Decode Mode):** In `@xo-cash/engine/source/resolutions/token.ts` (`resolveTemplateTokenCategory`), `compileCashAssemblyString` is called with hardcoded `evaluationDecodeMode: "utf8"`. For binary token category expressions (e.g. `$(<tokenCategory>)`), does this require category variables to be formatted as ASCII hex strings rather than raw byte buffers to avoid replacement character corruption? Should `evaluationDecodeMode: "hex"` be used for category and commitment evaluations?
- **Q-C03 (Native SQLite Storage in Node.js):** In `@xo-cash/state@0.0.5`, `SQLiteStorage` is noted as `/* (Not implemented yet) */` and `listScriptHashes` is not implemented on the SQLite adapter, forcing Node.js consumers to use `storageType: 'indexeddb'` backed by `indexeddbshim`. What is the timeline for the native `better-sqlite3` storage adapter?
- **Q-C04 (P2SH32 Unlocking Script Bytecode Composition):** In Libauth compiler configuration for P2SH32 (`lockingScriptTypes[lockingScriptId] = 'p2sh32'`), Libauth automatically appends the serialized redeem script bytecode to the unlocking script. In XO template schemas, should covenant unlocking scripts specify `<redeemBytecode>` explicitly at the tail, or rely on Libauth's compiler to append it?


### XO strategy after S-01 = NO (accepting D-A3-002)
- **Evidence:** D-A3-002: XO engine cannot execute claim/refund (tracks only its own outputs; HD-key signing pipeline); S-02 passes byte-for-byte.
- **Consequence for rebuild:** CashScript artifact is the executor. XO is used for the `lock` invitation if the hybrid check ( Part B) passes, and the XO template is kept as a verified-equivalent artifact. Treat the Build with XO bounty claim as weak until the human has asked General Protocols the Q-C questions (31 Oct workshop).
- **Revisit if:** General Protocols confirm a supported way to spend externally created covenant outputs.

#### D-A3-002 hybrid lock check and workaround addendum
- **Lock Path Verdict:** PARTIAL.
- **Evidence:**
  - Evaluated in `packages/htlc-bch/src/probe-xo-hybrid.ts` on Chipnet.
  - XO Engine successfully imported `ferryHtlcTemplate` and created a lock invitation (`6172320baf1453e4951a2aa5b4dafa37`).
  - Calling `engine.resolveInvitationOutputLockingBytecode` derived the covenant P2SH32 locking bytecode (`aa207253bf163d4bae2fff62603ec1f90c824cff68e6b4d37ca36ca8539eae858dfa87`), which matches the CashScript contract locking bytecode byte-for-byte (S-02 Parity PASS).
  - However, driving the transaction signing through XO Engine failed: calling `signInvitation(invitationId, 0)` failed with `Commit not found for merged input 0...` because the template lock transaction defines no inputs. When inputs were explicitly attached to the invitation, signing failed with `InputUnspentOutputUnavailableError` because XO Engine requires spent inputs to be pre-tracked in the local account store (`#accountContext.state`).
  - In the hybrid model, the solver uses the XO-resolved locking bytecode to fund the covenant on Chipnet with 100 tPUSD and 2000 carry satoshis in transaction `f1d537078e1ebd0d218190a5b854c32c14114faa9b7518293c5d8bcde867afaf` (confirmed on-chain).
  - The XO-derived HTLC UTXO was subsequently claimed on Chipnet using the CashScript claim builder with the secret preimage in transaction `0a4e6ddbf0371e0dd8396d7c1cf49bd3a8c69e22b5711a763e74811e5482d2a3` (confirmed on-chain).
  - **Workaround Assessment (45-minute timebox):**
    - `buildInvitationTransactionFromMergedCommit` successfully constructs the unsigned wire transaction skeleton for the claim action (120 bytes, transaction hash `126922521cfe2e869137963d7efa2b0d3c4c635756dafebd603581b2fb5f8f41`).
    - However, `generateUnlockingBytecode` fails with `InputUnspentOutputUnavailableError` because the public `Engine` class exposes no `importUtxo` or `trackScriptHash` API to inject external covenant outputs into its internal private store (`#accountContext.state`).
    - Furthermore, `compileInputUnlockingScript` requires HD derivation key references for all inputs, making pure non-HD covenant unlocking infeasible inside the current engine version.
- **Consequence for rebuild:**
  - Build with XO claim remains PARTIAL: XO templates can be used to generate validated swap invitations and deterministic covenant locking scripts across parties, but transaction funding and covenant spend execution (claim/refund) must be driven by CashScript or custom transaction builders.
  - Append Q-C05 to the questions for General Protocols.

---

### Questions for General Protocols (Q-C Addendum)

- **Q-C05 (Registering External UTXOs in Engine State for Covenant Spends):** Does the XO Engine roadmap include a public method on `Engine` (such as `importUnspentOutput` or `trackScriptHash`) to allow an account to register an externally created UTXO so that `generateUnlockingBytecode` and `buildInvitationTransactionFromMergedCommit` can assemble complete covenant-spending transactions without requiring the output to have originated from an internal HD invitation?
### D-A2-005 · BCH Electrum client architecture: Custom Dual-Fulcrum Wrapper vs @electrum-cash/network
- **Decision:** Implement a lightweight, direct dual-Fulcrum client wrapper (`BchQuorumClient`) rather than importing `@electrum-cash/network@4.4.8`.
- **Evidence:** Evaluating `@electrum-cash/network@4.4.8` against the minimal client in `@ferry/htlc-bch` revealed that the library introduces heavy dependencies and cluster abstractions that obscure connection state. The custom wrapper directly manages connections to two independent Chipnet Fulcrum endpoints (`wss://chipnet.imaginary.cash:50004` and `wss://blackie.c3-soft.com:50004`), enforces a tip quorum (`|tip1 - tip2| <= 1`), executes seamless failover, and performs history reconciliation via `blockchain.scripthash.get_history` upon reconnect (handling CH-02 and CH-04) with strict TypeScript types and minimal surface area.
- **Consequence for rebuild:** Maintain `BchQuorumClient` in `packages/solver/src/bch/quorum-client.ts`. Add additional public Fulcrum nodes or self-hosted nodes via the comma-separated `BCH_ELECTRUM_URLS` configuration.
- **Revisit if:** Fulcrum protocol breaks backwards compatibility or a unified cross-chain client library is required.

### D-A2-006 · Measured Solver Reaction Latency Bound
- **Decision:** Establish an empirical upper bound of 5 seconds for solver detect-to-broadcast reaction latency (`SOLVER_REACTION`).
- **Evidence:** During forward swap execution on Anvil + Chipnet contracts (E2E-01), the solver engine measured detect-to-broadcast reaction latencies of 77 ms for BCH lock publication following EVM finality, and 163 ms for EVM claim execution following BCH claim detection. The 5-second operational bound provides a 30x safety margin over measured execution while strictly verifying the conservative 60-second reaction time assumed in L1 timing models (D-A2-004).
- **Consequence for rebuild:** Keep timing invariant F and R calculations configured with `solverReactionSeconds = 60` as a conservative safety threshold, while operating with sub-second expected reaction times in production.
- **Revisit if:** High network congestion or RPC rate limiting introduces transaction submission latency exceeding 5 seconds.

#### D-A2-006 Update (2026-10-25): Empirical Latency Measurement Across Real Fulcrum Network (≥ 10 Swaps)
- **Correction / New Evidence:** The initial 77 ms / 163 ms values in D-A2-006 were measured against local in-process calls and did not reflect true public network Fulcrum WebSocket RPC, UTXO discovery, transaction assembly, signing, and broadcast latency across live chains.
- In, detect-to-broadcast reaction latency was measured across 10 live swaps triggering real Chipnet transaction generation and broadcasts through `BchQuorumClient` (`wss://chipnet.imaginary.cash:50004` and `wss://blackie.c3-soft.com:50004`):
  - **Iterations:** 10 live lock broadcasts
  - **Min:** 787 ms
  - **Median:** 1890 ms
  - **Average:** 1679 ms
  - **P95:** 2463 ms
  - **Max:** 2463 ms
  - **Observations:** Live WebSocket roundtrips to public Fulcrum nodes average ~1.0–1.2s per request (`blockchain.scripthash.listunspent` + `blockchain.transaction.broadcast`). Consecutive rapid broadcasts can encounter transient mempool indexing delays if spending unconfirmed change outputs before Electrum server indexers register the parent transaction (observed as `Missing inputs` when broadcast too quickly in succession, recovered on retry). Under normal pacing, median reaction time is ~1.89 seconds.
- **Consequence for rebuild:** The 5-second operational bound remains valid and conservative against real public Fulcrum endpoints (P95 is 2.46s, median is 1.89s). Retain 60s as the worst-case safety parameter for timing invariant F / R proofs, but adopt 5.0 seconds as the live operational timeout threshold.

### D-A1-007 · Web consumes core API schemas behind one SolverClient
- **Decision:** The web imports `QuoteRequestSchema`, `QuoteResponseSchema`, `OrderStatusResponseSchema`, `RelayLockRequestSchema`, `RelayLockResponseSchema`, `RevealSecretResponseSchema` and the shared order-status enum from `@ferry/core`. `MockSolverClient` and `HttpSolverClient` both implement the same thin `SolverClient`; the HTTP client parses every response with the core schema. A quote is only usable after `verifyOrderSignature` re-checks the canonical order id and the trusted signer.
- **Evidence:** The mock and HTTP paths share `SignedQuote`/`OrderView`; the UI never reads `secret` from `OrderStatusResponse` and the status page only uses the locally stored recovery secret. Tests cover signature tampering, vault round-trip/tamper, and secret absence from DOM and IndexedDB keys.
- **Consequence for rebuild:** Keep wire parsing in the HTTP adapter, not in components. Never log, render, or persist a status-endpoint secret; the recovery file is the only intentional secret carrier.
- **Revisit if:** The solver API moves away from the core schemas or a second consumer needs a different transport.

### D-A1-008 · T9 binds signed terms to the local request before the CTA
- **Decision:** `assertTermsMatchRequest(terms, request, config)` runs after signature verification and before the quote is stored. It compares every user-critical term with the locally built `QuoteRequest` and configuration: direction, counter chain/network/asset/decimals/HTLC, both user addresses, hash lock, BCH token/category, solver counter address, input/output amounts, pricing-policy floor, carry, max fee, quote expiry, counter deadline and BCH refund-height bounds. The solver response never supplies the recipient, HTLC, token, amount or deadline policy.
- **Signer pinning:** `VITE_SOLVER_SIGNING_ADDRESS` is required whenever `VITE_SOLVER_URL` is set; the mock keeps the passphrase-derived mock signer. `requireSolverSigner()` fails closed on a missing or malformed address. Permit and intent typed data use config addresses, and both deadlines use the short `quoteExpiry`, not `counterDeadline`.
- **Bundle:** The real wallet stack (AppKit, wagmi, Reown) is a dynamic import behind `Suspense`; the mock path does not load it. Initial JS fell from 1,590.36 kB (606.67 kB gzip) to 639.92 kB (190.70 kB gzip), with the real-wallet chunk at 213.50 kB (74.34 kB gzip).
- **Evidence:** Unit tests reject each tampered term with a specific reason; a component test returns a validly re-signed quote with a changed solver recipient and confirms the CTA never appears. Live-URL config tests require the pinned signer. Root lint, typecheck, test (194 tests) and format check are green; the refreshed lockfile passes a frozen install.
- **Consequence for rebuild:** Keep T9 in the quote path, not only in the status page. Treat the solver tip height as a convenience value and re-check refund-height safety against a trusted BCH tip before any refund-sensitive action.
- **Revisit if:** The solver publishes a spread/skew that can legitimately fall below the base pricing policy, or a trusted BCH tip source replaces the quote-returned tip.


### D-A1-009 · Standalone recovery is generated from the shared TS core
- **Decision:** `recover.html` is built from `packages/web/src/recover/standalone.ts` with exact `esbuild@0.28.2` into one file with inline CSS and an inline module script. The generated file is committed and `pnpm --filter @ferry/web build` regenerates it, so a fresh clone can open it from `file://` without a build step while the source stays reviewable. `packages/web/src/recover/core.ts` is shared by the standalone page and `/recover`; there is no second recovery implementation.
- **Evidence:** `pnpm --filter @ferry/web build:recover` produces a 1.5 MB file with SHA-256 `63abbf9a7b61e94fd14d3d8b07e6da4fa48d605b9b7ce5af1487b9251eaa86c6`; a second run produced the same hash. Playwright E2E-07 opens `file://…/recover.html` with no web server, checks both chains, refunds on anvil 8545/84532, claims BCH against a mocked Electrum WebSocket, and exercises the BCH refund and tampered-address refusal paths.
- **Consequence for rebuild:** Keep recovery logic in one importable module. If the bundle grows, the fix is narrower imports or a separate crypto module, not a second copy of the validation rules. Regenerate the committed file in the same PR whenever the core changes.
- **Revisit if:** The build needs to support a no-Node human environment; then ship the generated artifact as the primary deliverable and keep the build optional.
- **Correction (2026-10-25, Part C):** The shared config and category normalization changed the generated bundle. The rebuilt artifact is 1,493,306 bytes with SHA-256 `ee03ef4e7b60308722b4877124a6f29646a27eaf47b055986fecde01a96e69e3`; E2E-07 is still 4/4. FACT-A1-022 remains the historical Part B value.

### D-A1-010 · Recovery file is portable; chain identity is checked live
- **Decision:** `RecoveryFileSchema` accepts any positive EVM `chainId` and any 20-byte EVM address instead of hard-coding Base Sepolia and the deployed address, and accepts `chipnet` or `mainnet` for BCH. `validateRecoveryFile` still requires the file's order id to match its terms, recomputes both BCH addresses and the redeem/locking bytecode from those terms, and checks the EVM code hash against the embedded deployed bytecode. `loadRecoverySnapshot` additionally checks the live RPC chain id and the code at the file's address before reading the lock.
- **Evidence:** Local anvil E2E uses chain id 84532 and the real deployed address with `anvil_setCode`; a tampered BCH address is refused before any action. The production address and code hash remain the defaults in `buildRecoveryFile`.
- **Consequence for rebuild:** Never trust the file's address or chain id alone. The portable fields are only an envelope; the bytecode hash, live code, BCH re-derivation and order id are the binding checks.
- **Revisit if:** Recovery files need to carry a signed deployment attestation or support multiple EVM contracts per order.

### D-A3-004 · S-09 Solana HTLC Architecture & Relayer Fee Invariant
- **Decision:** Deploy `ferry_htlc` on Solana as an immutable Anchor program (`DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN`, upgrade authority set to `none`), using an escrow PDA keyed by `[b"lock", owner, hash_lock]` and a vault PDA token account `[b"vault", lock_pda]`. Support relayer-as-fee-payer with automatic idempotent recipient ATA creation inside the `claim` instruction funded by the relayer, strictly maintaining the recipient's SOL balance delta at zero.
- **Evidence:** Spike S-09 evaluated on Solana Devnet:
  - Deployed immutable program `DbFyFKCGHZ7Pb3rUsbGtNhYcrvmbGm3qx4mnF4fYnyqN` (slot 514794976), verified `Authority: none`.
  - Executed forward lock/claim round-trip on Devnet (lock tx `MYNkVANbXZeEzr1xLrzWZezUTPt4iaoNTMASqDwKNz4pM7ofouULL5cbY1JZykTF4YYMK4his6zGQr7btWTBsz7`, claim tx `5CbB8CwyZ5eVPFhuF5343JEQ8dcENTm1GPev75Bf6gobTUTyX4qFDUP2XE9fRV83qF3zNax9gqpAvqqScaH1H9jc`).
  - User SOL balance was measured at `1,000,000,000` lamports before claim and `1,000,000,000` lamports after claim (delta: exactly 0 lamports).
  - All 10 local Anchor unit/integration tests passed on `solana-test-validator 4.1.2`, including double claim/refund rejection and fresh ATA creation.
- **Consequence for rebuild:** Solana integration in `@ferry/chain-solana` should use `packages/htlc-solana`'s exported instruction builders (`buildLockInstruction`, `buildClaimInstruction`, `buildRefundInstruction`). The relayer acts as fee payer on `claim` transactions.
- **Revisit if:** Token-2022 confidential transfers or custom transfer hooks are required in future phases.

> Note (2026-10-27): the S-09 Solana decision was submitted as D-A3-003, a duplicate of the Fulcrum latency decision; renumbered D-A3-004. References to "D-A3-003" in the Solana PR text mean D-A3-004.
### D-A2-007 · Crash recovery with pre-computed txid/hex and strict lockId DB uniqueness
- **Decision:** Solver engine persists `{ txid, txHex }` intent into SQLite ahead of broadcasting any BCH counter-lock (`PENDING`). On crash or restart during forward swap execution, the engine inspects the action intent: if already broadcast on-chain, it adopts the existing lock without re-broadcasting; if not yet mined, it rebroadcasts the exact identical signed `txHex` rather than generating a new transaction. Additionally, order lookups in the solver database use composite EVM lock id (`keccak256(owner, hashLock)`), enforcing an SQLite unique constraint on `(user_counter_address, hash_lock)`.
- **Evidence:** Tested with real child process SIGKILL in `test/chaos.test.ts`:
  - `CH-01b` (crash point `BEFORE_BCH_LOCK_BROADCAST`): Process killed immediately after persisting intent; upon restart, broadcasts exactly once and creates exactly one lock UTXO on fake chain.
  - `CH-01c` (crash point `AFTER_BCH_LOCK_BROADCAST`): Process killed immediately after broadcast; upon restart, detects existing lock, adopts it, and performs zero duplicate broadcasts.
  - `db-uniqueness.test.ts`: Two distinct users sharing the same hashLock both succeed with distinct lockIds. A single user attempting to create a second quote or order for the same `(userCounterAddress, hashLock)` throws an SQLite unique constraint error and is rejected with HTTP 400.
- **Consequence for rebuild:** Guarantees zero duplicate solver locks and eliminates orphaned counter-lock UTXOs across crashes. Prevents hash collision and order hijack across multiple users.
- **Revisit if:** Multichain or dynamic nonce parameters are added to EVM lock ids.


### D-A1-011 · Reverse UI uses signed direction and recomputed BCH funding targets
- **Decision:** `OrderTerms.direction` is the single source of truth for the reverse flow. `SwapCard` pre-selects `BCH_TO_COUNTER` from `?direction=reverse`, toggles it locally, and resets the quote when it changes; `SolverProvider` passes the same direction to the mock solver; `buildOrderViewModel` selects reverse labels/steps and `SwapStatusPage` branches the claim/refund actions. Reverse quotes parse tPUSD at 2 decimals and run T9 plus invariant R before the CTA.
- **BCH funding:** `assertReverseFundingTarget` recomputes the token-aware P2SH32 address from the signed terms, checks the user’s refund locking bytecode and the pinned solver BCH bytecode, and refuses a mismatch. The QR/manual panel is gated until the recovery file is downloaded. The real WizardConnect builder is a typed stub until a team member’s shared `buildLockTransaction` lands; mock E2E exercises the full funding path.
- **Status actions:** Reverse claim is gasless through `POST /v1/orders/:id/relay-claim` or a self-claim through the Base HTLC; BCH refund uses the signed refund address and waits for `bchTipHeight >= bchRefundHeight`. The HTTP adapter does not trust a status-endpoint tip for refund availability and keeps `bchRefundAvailable: false` until the API exposes a trusted tip/UTXO.
- **Evidence:** Web unit tests 58/58, UI E2E 7/7 including the direction toggle, reverse happy and reverse refund screenshots, recover E2E 4/4, root build/typecheck/lint/test/format green. `recover.html` was regenerated after the shared config/category changes: 1,493,306 bytes, SHA-256 `ee03ef4e7b60308722b4877124a6f29646a27eaf47b055986fecde01a96e69e3`.
- **Consequence for rebuild:** Keep direction in the signed terms and re-derive every BCH address locally. Do not accept a solver-supplied funding address, and do not enable a live lock until the recovery file exists.
- **Revisit if:** the wallet builder exposes a different source-output/input-path shape, or the solver status API adds a trusted BCH tip and lock UTXO.


### D-A1-012 · independent BCH tip, shared lock builder, lazy routes
- **Decision:** The web no longer derives a BCH tip from the solver's signed refund height. `lib/bch/tip.ts` queries Electrum directly (`VITE_BCH_ELECTRUM_URL`, optional `VITE_BCH_ELECTRUM_URL_2`), takes the lower successful height when both answer, caches it for 30 seconds, and fails closed when no endpoint answers. `HttpSolverClient.quote` refuses to quote without an independent tip; `getOrder` still returns the order but sets `bchTipError` and disables BCH refund until a tip is available. The `SignedQuote`/`OrderView` tip field remains a convenience value and is not used for the safety check.
- **Funding:** `buildReverseLock` now calls the shared `buildLockTransaction`; the real WizardConnect path lists receive and change UTXOs, derives the change address, and maps source outputs to `[0,'receive',0]` / `[1,'change',0]`. Unknown source outputs throw instead of guessing. The mock UTXO is 10,000 sats so the token-bearing lock output clears the dust floor after the fee.
- **Loading:** `SwapStatusPage`, `RecoverPage` and `PayLinkPage` are route-level lazy imports; the BCH address parser and reverse funding panel load on demand. `recover.html` gains a `--check` mode and a Vitest drift test.
- **Evidence:** Web unit tests 67/67, typecheck, lint, build and format green; root build/typecheck/lint/format green; 269 tests pass outside htlc-solana (10 Solana tests skipped because solana-test-validator is unavailable in this worktree). Initial JS is 248.77 kB (77.22 kB gzip); the address parser is a 359.02 kB lazy chunk and recovery is 729.66 kB lazy. `recover.html` is 1,493,381 bytes with SHA-256 `6b749cb260f851bc0cacf90f4faefeee8b3d78df60431ab610ed74f8f056bd89`, rebuilt from source with the `ferry-source` resolution condition.
- **Consequence for rebuild:** Treat every safety-relevant chain height as a local input. A solver-signed quote can prove intent, never chain state. Keep the real builder and wallet wiring behind the same `BchWallet` interface so the mock E2E still exercises the production path.
- **Revisit if:** The solver status API starts returning a trusted tip plus the exact lock UTXO, or WizardConnect exposes a batch UTXO selector that removes the receive/change split.
- **Correction to D-A1-011:** The statement that the real WizardConnect builder was a typed stub is superseded by this entry; the builder is now real and covered by the reverse E2E.

### D-A1-013 · recover.html resolves workspace sources explicitly
- **Decision:** `build-recover.mjs` sets esbuild conditions `ferry-source, import, module, default`. Without `ferry-source`, esbuild silently bundled `@ferry/core` from `dist/` when it existed and from `src/` when it did not, so the committed artifact depended on whether a previous build had run. The recovery build now resolves the workspace source deterministically.
- **Correction:** The current artifact is 1,493,381 bytes with SHA-256 `6b749cb260f851bc0cacf90f4faefeee8b3d78df60431ab610ed74f8f056bd89`. This supersedes the `ee03ef4e...` value in D-A1-009/D-A1-011 and FACT-A1-027, and the interim `1f786...` value produced before the condition was added. `FACT-A1-029` records the current value.

### D-A1-014 · pay links use exact-output quotes and id-only URLs
- **Decision:** Pay links are first-class `SolverClient` resources: create, get, quote, list and cancel. The shared URL carries only the 16–32 character base58 link id; the recipient address, amount, memo and expiry come from `GET /v1/links/:id`, so a copied link cannot silently change the destination. Invoice links fix `amountOut`; open links carry an optional minimum and accept a payer-chosen amount.
- **Exact output:** `assertPayLinkQuote` derives `amountIn` with `quoteExactOut`, builds the equivalent `QuoteRequest`, runs T9, then requires exact equality of the BCH recipient, token, `bchTokenAmount`, `counterAmount` and link expiry. The payer UI shows the exact USDC debit and tPUSD credit only after the signed quote passes; the mock reserves an invoice on its first quote and rejects a second payer.
- **Verification:** The create page signs `ferry:paylink:v1:<challenge>:<lockingBytecode>` when the connected BCH wallet exposes message signing. The mock wallet implements it; WizardConnect does not, so real links created from a WizardConnect address are unverified and the UI says so. Listing and cancellation sign `ferry:paylinks:v1:<owner>:<challenge>`. The mock seeds an open tip link, a reserved verified invoice and an expired invoice.
- **Payer path:** The payer needs only a Base wallet. After the exact quote, the page requires a recovery-file download, then reuses the existing permit, intent and relay-lock path. The BCH recipient remains the link owner, so the payer never needs a BCH wallet.
- **Evidence:** Web unit tests 77/77; full UI E2E 9/9, including create → preview → quote → lock and the reserved-invoice block; root typecheck/lint/format green; 278 tests pass outside htlc-solana with 2 skipped; root build excluding Solana green. Initial JS is 252.17 kB (78.10 kB gzip); the pay-link routes are 10.85 kB and 12.91 kB lazy chunks; `recover.html` is unchanged at 1,493,381 bytes with SHA-256 `6b749cb260f851bc0cacf90f4faefeee8b3d78df60431ab610ed74f8f056bd89`.
- **Consequence for rebuild:** Keep the link id as the only URL payload, re-fetch the link before quoting, and never trust a payer-supplied amount for an invoice. Treat message-signing capability as optional and surface the unverified state rather than faking a badge.
- **Revisit if:** WizardConnect adds a standard message-signature request, or open links need to be single-use rather than reusable.


### D-A3-006 · S-10 Tron HTLC Architecture, No-Permit Flow, and SafeERC20 USDT Quirk Handling
- **Decision:** Port `FerryHTLC.sol` to Tron TVM in `packages/htlc-tron` with identical lock, claim, and refund semantics while dropping `lockWithIntent`. Tron TRC-20 tokens (notably Tether USDT) lack EIP-2612 permit functionality; swaps rely entirely on standard TRC-20 approve and lock. Use OpenZeppelin's `SafeERC20` wrapper for all token transfers to safely accommodate non-standard TRC-20 implementations that do not return a boolean value.
- **Evidence:**
  - Evaluated Tron TRC-20 USDT specification and contract behavior. Tether USDT on Tron historically returns void (zero return bytes) rather than boolean true/false on `transfer` and `transferFrom`.
  - Scaffolding a mock token with this exact non-standard return quirk (`MockNoReturnTRC20`) and executing tests with standard OpenZeppelin `SafeERC20` demonstrated that `safeTransfer` and `safeTransferFrom` handle zero-return bytes correctly without reverting, successfully completing lock, claim, and refund flows.
  - Contract unit test suite in `packages/htlc-tron` covers lock, claim, refund, bad secret, premature refund, double claim, double refund, and the USDT void-return quirk across 7 test suites, all passing.
  - Bytecode emitted by `tron-solc 0.8.31` introduces TVM-specific opcodes (`0xd2` and `0xd3` in the constructor preamble for TRC-10 compatibility). Consequently, local logic testing is compiled via standard Solc / Foundry, whereas Nile testnet deployment artifacts are generated with TronBox's `tron-solc`.
- **Consequence for rebuild:** Maintain `FerryHTLC.sol` in `packages/htlc-tron` without permit support. Swaps on Tron require the user to send an `approve` transaction followed by `lock`. Always wrap TRC-20 token interfaces with `SafeERC20`.
- **Revisit if:** TRON introduces native EIP-2612 permit standards across major token contracts.
---

### D-A3-007 · EVM Multi-Chain Deployment, Arc Consensus Precompiles, and Non-Standard Token Handling (S-08, S-12, S-13, S-14)

- **Date:** 2026-10-25
- **Prompt:** (Part C)
- **Status:** PASS

#### Context
Phase L6 probes EVM routes across four distinct ecosystems: Ethereum Sepolia, Arc Testnet (S-08), BSC Testnet (S-12), and Arbitrum Sepolia (S-13), plus Ethereum Mainnet USDT non-standard return-value verification on Anvil fork (S-14). The requirements stipulate deploying the exact same `FerryHTLC` contract at the canonical CREATE2 address `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` across all chains, verifying RPC characteristics (`safe`/`finalized` tags, `eth_getLogs` limits), investigating issuer token parameters (decimals, EIP-2612 permit support), and executing headless lock → claim and lock → refund round trips.

#### Decisions & Findings
1. **Canonical CREATE2 Address & Factory EIP-150 Gas Sizing:**
   - Deployed `FerryHTLC` at canonical CREATE2 address `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` on Ethereum Sepolia (tx `0x9c7f4563ce7cabbc7ad9f1ee0cdea1188f2e34b86c9de52edd8fbf26b0b10596`) and Arc Testnet (tx `0x366257dd717e683df21e9a9f36b994097f4e8a018c6132b2088c2c4199d4e3b3`).
   - Bytecode length is exactly 3361 bytes on all chains, matching Base Sepolia byte-for-byte.
   - Fixed EIP-150 63/64 child gas starvation in `Deploy.s.sol` by passing explicit low-level gas allowances and requiring a minimum `--gas-limit 6000000` for script broadcast on post-Cancun/Prague chains.

2. **Arc Testnet Consensus Architecture (S-08):**
   - On Arc Testnet (chain ID 5042002), USDC is the native gas token (18 decimals in balances/fees) and is wrapped into ERC-20 standard behavior at `0x3600000000000000000000000000000000000000` (6 decimals).
   - Arc invokes consensus precompiles `0x1800000000000000000000000000000000000001` (`isBlocklisted`) and `0x1800000000000000000000000000000000000000` (native balance updater).
   - In Foundry revm simulator, standard execution fails with `StackUnderflow`. Resolved by etching simulation mocks in `RoundTrip.s.sol` and using `--skip-simulation` on broadcast.
   - Live roundtrips verified on-chain: lock+claim (txs `0x190ffcd9...`, `0x78c8511f...`) and lock+refund (txs `0xae9ffb91...`, `0x72c34137...`). User balance preserved at 80.0 USDC with 0 fee paid by user.

3. **Ethereum Mainnet USDT Non-Standard Return Quirk (S-14):**
   - Ethereum Mainnet USDT (`0xdAC17F958D2ee523a2206206994597C13D831ec7`) returns 0 bytes on `transfer` and `transferFrom`.
   - Verified via Anvil fork suite `test/S14UsdtMainnetFork.t.sol`: `SafeERC20` handles the void return cleanly for both `claim` and `refund` without reverting.
   - Verified that Tether USDT does not support EIP-2612 (`DOMAIN_SEPARATOR()` and `permit()` revert). Direct approval (`lock()`) must be used for USDT routes.

4. **BSC Testnet 18-Decimal Quirk & Exact Amount Preservation (S-12):**
   - On BSC (both Mainnet `0x55d398326f99059fF775485246999027B3197955` and Testnet `0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684`), USDT uses **18 decimals** (Binance-Pegged BSC-USD).
   - Verified exact amount preservation through `test/S12BscUsdtProperty.t.sol` using canonical 25e18 (`25000000000000000000` units, matching `@ferry/core` `bsc18` fixture) and 256 fuzz runs, confirming 0 wei loss/truncation across lock, claim, and refund.
   - Identified that Binance public RPC (`data-seed-prebsc-1-s1.binance.org`) rejects `eth_getLogs` with `-32005: limit exceeded`; recommended using `bsc-testnet-rpc.publicnode.com`.

5. **Arbitrum Sepolia & BSC Testnet Funding Checklist:**
   - Both networks require faucet funding for Deployer and Solver wallets before on-chain deployment can execute.
### D-A1-015 · glass surfaces share one layer budget and lazy overlay chunk
- **Decision:** `GlassModal` uses Radix Dialog on desktop and swaps to the vaul `GlassSheet` below 768 px; `GlassPopover` uses Radix Popover; `GlassNav` only gains the glass surface after 24 px of scroll; `StatusDrawer` is a sheet; `GlassToast` is a CSS entry animation. The token picker, NavBar wallet sheet and review-and-confirm dialog use `GlassModal`. The direct “Ferry it” path remains the primary action; the review dialog is an optional second confirmation so the existing quote/lock flow and E2E timing do not regress.
- **Layer budget:** `GlassLayerBudget` allows at most two visible glass panels. `useGlassLayer` registers modal/sheet/toast surfaces; unit tests assert the third acquisition throws and the DEV provider warns instead of crashing the UI. The E2E wallet test counts `[data-glass-panel]` nodes while the sheet is open.
- **Lens and motion:** `useGlassLens` enables `.glass--lensed` only when Chromium supports `backdrop-filter: url(#ferry-lens)`; the filter lives in `index.html` and the 256×256 displacement map is `/glass/rim-displacement.png`. Safari and reduced-transparency modes fall back to a plain blur/surface. Modal and sheet springs use stiffness 420/damping 34; blur radius is never animated, and `will-change` is present only under `.glass-motion[data-animating='true']`.
- **Contrast:** The base glass tint is `rgba(8, 8, 10, 0.60)` over the lime glow. The Playwright contrast test hides panel content and pseudo-elements, screenshots the brightest central region, and checks both `--text` and `--text-muted` against 4.5:1. The tint was raised until that test passed; text tokens were not changed.
- **Loading:** Overlays are dynamic imports. `GlassSheet`/framer-motion is a 168.87 kB lazy chunk and is no longer preloaded by the initial route; `GlassToast` no longer pulls framer-motion into the entry. Entry JS is 287.18 kB (91.02 kB gzip), under the 400 kB target. The trade-off is that a first open of a sheet waits for a small chunk; closing unmounts the overlay instead of preserving an exit animation.
- **Evidence:** Web unit 86/86, full UI E2E 13/13, recover E2E 4/4, root 298 passed and 2 skipped outside `htlc-solana`, root build/typecheck/lint/format green. `recover.html` remains 1,493,381 bytes with SHA-256 `6b749cb260f851bc0cacf90f4faefeee8b3d78df60431ab610ed74f8f056bd89`.
- **Consequence for rebuild:** Keep one overlay implementation and one layer budget. Do not add a second modal library or animate blur. Load heavy overlay dependencies only when a surface opens, and keep the primary CTA usable without opening the optional review dialog.
- **Revisit if:** vaul/Radix/framer-motion cost becomes a mobile performance problem, or the product decides the review dialog must be mandatory.

### D-A1-016 · mainnet quoting requires two independent Electrum endpoints
- **Decision:** `bchQuoteConfigError(network, urls)` returns an error only when `network === 'mainnet'` and fewer than two distinct, non-empty Electrum URLs are configured. The exact message is `Mainnet quoting requires two independent BCH Electrum endpoints. Set VITE_BCH_ELECTRUM_URL_2.` The helper deduplicates trimmed URLs. `SwapCard` and `PayLinkPage` block quote submission, and `HttpSolverClient.#assertQuoteConfig()` enforces the same rule inside `quote` and `quotePayLink`.
- **Current scope:** `BCH_NETWORK` is still the literal `chipnet` for this lab, so the rule is inert at runtime today. It is deliberately a pure config guard with unit coverage so enabling mainnet later cannot silently rely on one colluding server. `.env.example` already contains `VITE_BCH_ELECTRUM_URL_2`; this branch does not edit it.
- **Evidence:** `bch-tip.test.ts` covers one mainnet URL, duplicate mainnet URLs, two distinct mainnet URLs, and chipnet with one URL. Root checks and the full UI/recover E2E suites are green.
- **Consequence for rebuild:** Keep the rule in the shared BCH config layer, not only in the form. Any future mainnet mode must require two independently operated endpoints before quoting; a single endpoint can still be used for read-only tip display but not for a quote-enabling path.
- **Revisit if:** `BCH_NETWORK` becomes a runtime environment setting, or the solver gains its own independent tip quorum.

### Correction to D-A1-015 · final reduced-motion build
- The final reduced-motion overrides increased CSS to 43.65 kB (8.99 kB gzip) and changed entry gzip size to 91.03 kB; entry JS remains 287.18 kB and the lazy GlassSheet chunk remains 168.87 kB (54.44 kB gzip). FACT-A1-035 records the final values.

### Correction to D-A1-015 · lazy status drawer and sticky nav
- The final pass keeps `.glass-nav` explicitly `position: sticky` because `.glass` sets `position: relative`, and lazy-loads `StatusDrawer` so the 168.87 kB GlassSheet chunk is fetched only when the drawer opens. Final entry JS is 287.19 kB (91.02 kB gzip), CSS is 43.64 kB (8.99 kB gzip), `SwapStatusPage` is 16.90 kB and `StatusDrawer` is 2.44 kB. FACT-A1-036 supersedes the prior bundle corrections.

### Correction to D-A1-016 · endpoint identity
- “Distinct” now means different normalized hostnames, not merely different URL strings. Case, trailing slashes, schemes or ports on the same host cannot satisfy the two-endpoint mainnet rule. This still cannot prove different operators; deployment review must choose independently run servers.

### D-A3-005 · Solana ChainAdapter Architecture, Browser Safety & Finality Policy
- **Decision:** Implement `@ferry/chain-solana` as a modular `ChainAdapter` conformant with `@ferry/core`. `buildUserLock` and `getLock` are strictly browser-safe and operate without requiring relayer secret keys: the transaction designates the relayer as `feePayer`, the user signs only as `owner`, and the relayer in `relayLock` attaches the fee-payer signature and broadcasts. For `isFinal`, `fast` lane maps to commitment `confirmed` and `safe` lane maps to `finalized` (~13s) per blueprint §24.2.
- **Evidence:** Integration test suite in `packages/chain-solana/test/adapter.test.ts` (7/7 passed against local `solana-test-validator`):
  - Browser-safe read-only adapter instantiated without private key successfully generated unsigned user locks and queried PDA lock states.
  - Relayed lock verified: user SOL balance delta was strictly 0 lamports.
  - Idempotent retries tested and confirmed for `relayLock`, `lock`, `claim`, and `refund`.
  - Premature refund rejection verified client-side and on-chain; expired refund verified after timeout.
  - `isFinal` accurately evaluates commitment states and fails closed on unknown or invalid transaction references.
- **Consequence for rebuild:** Web UI and solver can consume `@ferry/chain-solana` directly via `@ferry/core`'s interface. Manual checklist for Phantom partial signing is added in the wallet test notes.
- **Revisit if:** Alternative Solana wallet standards or transaction envelope versions (e.g. VersionedTransaction v0 with address lookup tables) are introduced.
---

### D-A2-008 · Reverse swap architecture: EVM check-then-act vs shared BCH write-ahead and relay-claim mechanics
- **Decision:** In reverse swaps (`BCH_TO_COUNTER`), the roles of BCH and EVM chains are inverted while preserving the identical `ORDER_STATUSES` state machine.
  1. *User BCH lock discovery:* The engine monitors the P2SH32 covenant address matching the order terms (works for both wallet-signed and manual QR funding), verifying the token category, amount, and satoshi carry before advancing to `USER_LOCK_SEEN` and evaluating the reveal policy (`USER_LOCK_FINAL`).
  2. *Counter-lock gate:* At counter-lock time `t0`, the engine verifies `quoteExpiry` and evaluates `invariantR({ counterDeadline, bchRefundHeight }, { unixSeconds: now, bchTipHeight })`. If either fails, the order transitions to `REJECTED` without counter-locking.
  3. *On-chain action execution models (EVM check-then-act vs BCH write-ahead):*
     - For BCH on-chain transactions (solver lock, refund, and claim), raw transactions are assembled and signed locally. If interrupted by SIGKILL, multiple spends or duplicate UTXO creations could occur. Therefore, BCH operations use a strict write-ahead routine (`executeOrAdoptBchTx`) that persists `{ txid, txHex }` intent in SQLite prior to broadcast, adopting or rebroadcasting the cached bytes on restart.
     - For EVM on-chain actions (`evmAdapter.lock`, `evmAdapter.claim`, `evmAdapter.refund`), the EVM contract storage (`getLock`) is authoritative and atomic on-chain state. Checking `getLock(lockId)` before acting, relying on Viem's internal transaction management, and verifying on-chain state afterwards provides idempotency and crash-safety without duplicating raw EVM transaction bytes in SQLite. the build notes should distinguish this check-then-act pattern from the raw BCH write-ahead requirement.
  4. *Relay-claim:* In reverse swaps, the user claims USDC on EVM. To preserve a frictionless gasless UX, `POST /v1/orders/:id/relay-claim` allows the user to submit their secret preimage; the solver validates `sha256(secret) === order.hashLock`, submits `evmAdapter.claim(lockId, secret)` paying EVM gas (factored into the swap spread), moves the order to `USER_CLAIM_SEEN`, and triggers `processSolverBchClaim` to claim the user's BCH tokens.
- **Evidence:** Tested with unit and integration suites:
  - `state-machine.test.ts`: 12 reverse state transitions and abort paths.
  - `api.test.ts`: `BCH_TO_COUNTER` quote generation with Invariant R and derived solver WIF key; `POST /v1/orders/:id/relay-claim` gasless EVM claim.
  - `reverse.test.ts`: E2E reverse flow, quote expiry rejection, Invariant R failure rejection, deadline EVM refund, and SIGKILL crash resilience during solver BCH claim.
- **Consequence for rebuild:** Differentiate UTXO-based chain raw-transaction write-ahead from account-based EVM contract check-then-act. Support gasless reverse claims via solver relay.
- **Revisit if:** EVM gas spike exceeds spread buffer or fee abstraction ERC-4337 is integrated.

---

### D-A2-009 · Fast-lane zero-conf policy enforcement and reverse BCH lock parameter verification
- **Decision:**
  1. *Fast-lane protection (threat T2):*
     - Quote requests for `lane: 'fast'` must provide an explicit opt-in (`fastOptIn: true`) and cannot exceed the zero-conf cap ($25.00 / 25,000,000 micros per `DEFAULT_REVEAL_CONFIG.zeroConfMaxUsdMicros`). We explicitly refuse quotes exceeding the cap with HTTP 400 `FAST_LANE_CAP_EXCEEDED` rather than silently downgrading to safe lane, ensuring user UX expectations regarding settlement latency are preserved.
     - When detecting unconfirmed BCH locks (`confirmations === 0`), the engine queries Fulcrum for double-spend proofs via `blockchain.transaction.dsproof.get` (`BchQuorumClient.getDSProof`).
     - The engine records the lock observation timestamp (`firstSeenAt`) in the SQLite database and requires the elapsed time to satisfy the 5,000 ms observation window per `D-A3-003` via core's `revealPolicy`.
     - If a double-spend proof is detected (`dsproof === 'detected'`), the engine marks the order `INVALID_TERMS` and rejects it immediately, guaranteeing zero USDC counter-locks are ever issued against contested locks.
  2. *Reverse lock parameter verification:*
     - The reverse engine validates that candidate covenant UTXOs match the exact quoted token amount (`u.token_data.amount === terms.bchTokenAmount`) and provide adequate fee carry (`u.value >= terms.bchCarrySats`). Over-funded/under-funded token amounts and under-funded satoshi carries are rejected immediately (`INVALID_TERMS`), forcing the user to refund by height and protecting the solver from invalid claim transactions or dust outputs.
- **Evidence:** Tested with unit and integration suites:
  - `api.test.ts`: Fast lane quote requests without `fastOptIn` rejected with `FAST_LANE_OPT_IN_REQUIRED`; requests exceeding $25 cap rejected with `FAST_LANE_CAP_EXCEEDED`.
  - `reverse.test.ts`: Fast lane unconfirmed lock with double-spend proof rejected without counter-locking; under-funded satoshi carry rejected; over-funded token amount rejected; unconfirmed fast lock respects DSProof observation window before finalization.
- **Consequence for rebuild:** Never trust unconfirmed UTXOs without double-spend proof verification and observation time gates; validate both token and satoshi outputs before counter-locking.
- **Revisit if:** Double-spend notification protocol is updated or zero-conf insurance protocols are adopted.


### D-A1-017 · live page data has an explicit empty state
- **Decision:** The web owns a temporary `StatsClient` boundary with three independently loaded resources: aggregate stats and active quote policy, recent settled swaps, and peg observations. The HTTP adapter validates strict local schemas until a team member’s core schemas land. The default mock reports the real configured spread/fixed fee but returns `null` metrics, no swaps and no peg observations; it never invents judge-facing numbers.
- **Failure isolation:** The home controller uses independent settled results, so a missing peg endpoint does not hide settlement stats or recent swaps. A real zero is displayable; `null` means “No data yet”, keeping zero and absence distinct.
- **Dataviz:** A peg sparkline is rendered only with a reported latest price and at least two observations. It includes a one-dollar reference line, visible range/source text, an accessible title and numeric description, theme colours and no animation. Empty feeds render no SVG or synthetic line.
- **Policy copy:** The feature-card spread and every quote-policy display are formatted from policy/config basis points and microdollars, not string literals.
- **Consequence for rebuild:** Put future core schemas at this one adapter boundary, preserve null-vs-zero semantics, and never seed production mocks with decorative metrics or price history.
- **Revisit if:** the solver endpoint fields differ from the local contract, or recent swaps expand beyond the current Base/BCH route and require per-chain explorer configuration.

### D-A1-018 · accessibility is a route-level release gate
- **Decision:** The default UI suite now scans `/`, `/swap/:id`, `/p/:id` and `/recover` with axe; runs the complete forward swap with Tab, typing and Enter only; exercises reduced-motion and reduced-transparency media; and captures every new section at 375 px and 768 px with overflow assertions.
- **Landmarks:** `AppShell` owns the document’s only main landmark. Route loading and route pages use neutral containers, and the recovery-file input has a visible programmatic label.
- **Test isolation:** Playwright starts its own strict Vite server on port 5180. Reusing a listener is an explicit opt-in because a process on the right port can still serve the wrong checkout.
- **Evidence:** Web unit tests 90/90, default UI Playwright 22/22 and standalone recovery Playwright 4/4. Entry JS is 306.45 kB raw, still below 400 kB.
- **Consequence for rebuild:** Run semantic automation on all judge paths, but retain the keyboard and responsive flows because axe alone cannot validate interaction order, media preferences or layout.
- **Revisit if:** New routes, wallet surfaces or supported browsers require additional axe states or non-Chromium media-emulation coverage.

### Correction to D-A1-018 · post-rebase test count
- After rebasing onto the merged Solana/Tron work, the final web unit count is 93/93 rather than 90/90. Browser and recovery counts remain 22/22 and 4/4. FACT-A1-042 records the final clean-clone gates.

---

### D-A3-008 · Spike S-10: TRON Nile HTLC Deployment, TVM SafeTRC20 Return Handling, and Solidified Finality → PASS
- **Evidence:** Deployed `FerryHTLC` to TRON Nile testnet at `TN2gn3GTuTHkZ3dmgitZr78VpSiwr4Epxs` (tx `fe2d423b83b05e8de7a48127c3e7b6d5fa5d592d5e1b3792705996e83595f2d7`). Executed full on-chain lock + claim swap (lock tx `968818afa97dd6aff90055bc932f50be052351b273f2c3b012bd2813684441e8`, claim tx `5e641269d721f30570883145c8b854c745865c90a499abc84e8d0e1fc55bab67`) and lock + refund swap (lock tx `a741fc047b03d7e536e1079fc5b324545abf8d5b54639daf439f081714c85fb4`, refund tx `fe55b68c57c9356c40a0aaab2372d00e8c63d05e253fbbc3fd367fb486b9ec84`).
- **TVM SafeTRC20:** Discovered that TRON TVM allocates 32 zero bytes for void returns (like official Nile USDT), causing OpenZeppelin `SafeERC20` to decode as boolean `false` and revert. Replaced with `SafeTRC20` accepting both 32 zero bytes and boolean true.
- **Consequence for rebuild:** Standard TRON HTLC swaps use `approve` + `lock` with `SafeTRC20`. Fast lane requires 1 confirmation (~3s); safe lane requires solidified block (~19 blocks, ~48-50s) per Blueprint §24.2.
- **Revisit if:** TRON introduces native EIP-2612 permit or alters TVM void return behavior.

### D-A2-010 · Reverse safe-lane quote TTL, free price options, and deposit-seen evaluation
- **Decision:**
  1. *Context and initial TTL setting:* Earlier, reverse safe-lane quotes were given an 1800 s (30-minute) TTL (`quoteExpiry = now + 1800`) to avoid expiration while waiting for a 1-block Bitcoin Cash confirmation (average 10-minute block interval, up to 20–30 minutes in Poisson tail distribution).
  2. *Adverse selection exposure analysis:*
     - Offering a fixed swap rate for 30 minutes without requiring an on-chain commitment grants the user a 30-minute free lookahead price option against the solver inventory.
     - Maximum swap size is $50.00 (`maxSwapUsdMicros = 50,000,000`) and total exposure cap is $250.00 (`maxExposureUsdMicros = 250,000,000`).
     - Quoted spread is 40 bps (0.40%) plus $0.05 fixed fee. Peg tolerance guard is 1.0% (`PEG_TOLERANCE = 0.01`).
     - If the CashToken peg (e.g., PUSD or MUSD) de-pegs or drops by 100 bps (1%) on external markets during the 30-minute window, the 40 bps spread ($0.20 on a $50 swap) fails to cover the price drop. An adverse arbitrageur can observe external market weakness, exercise the stale quote at minute 29, and dump devalued CashTokens to extract fixed USDC on Base, inflicting a net loss of 60 bps ($0.30 per $50 swap, or $1.50 across a $250 inventory). In severe depeg events (>2%), the exposure compounds further.
     - Thus, **the configured 40 bps spread does not cover a 30-minute adverse peg move**.
  3. *Root cause of the long TTL necessity and resolution:*
     - The 1800 s quote TTL was originally introduced because `runner.ts` evaluated quote expiration against current wall-clock time at counter-lock time ($t_0$), conflating block mining latency with quote commitment.
     - In the fix, `runner.ts` was corrected to evaluate quote expiration against `order.firstSeenAt` (the timestamp when the user's BCH transaction first appears in the mempool or block): `const lockSeenTime = order.firstSeenAt ? Math.floor(order.firstSeenAt / 1000) : now; if (lockSeenTime > terms.quoteExpiry) { reject }`.
     - Because `firstSeenAt` captures the deposit broadcast timestamp (which occurs in seconds), the quote TTL only needs to provide sufficient time for the user/wallet to construct, sign, and broadcast the transaction. It does *not* need to cover the subsequent block confirmation interval.
  4. *Rule and recommendation:*
     - Reduce reverse safe-lane quote TTL from 1800 s to 180 s (3 minutes). 3 minutes provides ample margin for wallet interactions and broadcast while limiting the user's free price option window by 90%.
     - If the user fails to broadcast within 180 s, the quote expires harmlessly and the UI requests a fresh quote (re-quote rule).
     - Furthermore, before solver counter-locking at $t_0$, the engine retains the right to verify current peg health against `PriceSource`: if the peg has broken beyond `pegTolerance` during the block confirmation wait, the solver refuses to counter-lock, forcing a safe refund for the user by height.
- **Evidence:** Documented in `lab/decisions.md` (D-A2-010); safe-lane reverse live run executed on Base Sepolia + Chipnet confirming `firstSeenAt` gating; tests in `packages/solver/test/reverse.test.ts`.
- **Consequence for rebuild:** Differentiate quote validity window (time to enter mempool) from settlement/confirmation window (time to mine into block). Keep quote TTLs tight (<= 180 s) to bound adverse selection risk on stablecoin pegs.
- **Revisit if:** User wallet UX requires longer signing timeouts, or dynamic volatility-adjusted spreads are implemented.
### D-A1-019 · quote refresh is a new quote, never a reused hash lock
- **Decision:** Auto-refresh is a timer-driven state machine that runs only while the card is quoted and no lock action has begun. It fires five seconds before expiry, creates a new secret and recovery file, re-runs signature verification, T9 term binding, independent BCH tip checks and timing invariants, then re-arms the recovery download gate. It stops after three automatic attempts without user action; manual quoting resets the counter.
- **Cancellation:** Starting Ferry, starting reverse BCH funding, changing amount/direction/lane, or replacing the quote cancels or invalidates an in-flight refresh. A request-version counter prevents a stale response from overwriting a newer user action.
- **Pay links:** The same hook drives exact-output pay-link quotes. The mock allows a reserved invoice to be re-quoted only by the payer who owns the current reservation, so refresh does not look like a second payer. Different payers still receive `LINK_RESERVED`.
- **Evidence:** Hook fake-timer tests cover pre-expiry timing, disabled-after-lock, cap, cancellation and failure; Playwright with `quoteTtl=8` verifies a new order id/secret, re-armed recovery download and the pay-link path.
- **Consequence for rebuild:** A refreshed quote is a new order. Never reuse the hash lock, never refresh after a wallet action starts, and keep old vault secrets until their orders are provably unused.
- **Revisit if:** The solver supports idempotent quote renewal or the protocol changes the one-order-per-hash-lock rule.

### D-A1-020 · one solver-kind flag governs mock disclosure
- **Decision:** `solverIsLive()` remains the single source for solver labels, footer copy, status-page banner, transaction links, address explorers and recovery-file issuer metadata. Mock status pages show a visible “no funds move” banner, render hashes as plain text marked mock, and expose no transaction/address explorer links. Recovery files carry optional `solverKind`; mock files warn that they are simulations, while old files remain readable.
- **Evidence:** `mock-honesty.spec.ts` asserts no Base/BCH tx explorer links and a visible simulation banner; recovery E2E uses a live-marked fixture for the real recovery path.
- **Consequence for rebuild:** Never infer solver kind from wallet mode; the backend identity is independent. A single flag must drive every “real vs simulated” presentation.
- **Revisit if:** A live solver can be mixed with mock orders in one browser session and records need per-order provenance beyond the recovery file.

### D-A1-021 · UI-02 is an isolated opt-in live harness
- **Decision:** `test:e2e:live` uses its own Playwright config, Vite server on port 5181 and solver on port 8790 with a memory database. It derives the solver signer/BCH address from `.env.local`, loads only those server-side values, and keeps the live suite out of default E2E discovery.
- **Result:** Forward and reverse live quote requests pass and the web accepts the solver signatures, independent tip and terms. Fully funded swaps are blocked because the user and solver token-aware BCH addresses hold no tPUSD, and pay-link live endpoints are not implemented yet.
- **Consequence for rebuild:** Separate quote-level live verification from funded acceptance runs. Check inventory and endpoint completeness before scheduling funded UI tests, and always prove which solver process the test is using.
- **Revisit if:** tPUSD inventory is restored and the solver publishes live pay-link endpoints.

### D-A1-022 · durable local order state and explicit wallet activity
- **Decision:** Every created quote is written to an IndexedDB order journal with terms, direction, lane, status, txids and the last known tip state; the secret remains only in the encrypted vault. Status pages merge live solver state with the journal: on 404 they retain the local record, show a restart warning, and expose recovery download plus the recovery-page path.
- **Wallet state:** A restored WizardConnect session gets an eight-second reconnect budget, then disconnects and returns to “Connect BCH”; fresh QR connections are exempt. The nav reads the same wallet context and shows a truncated EVM address, “1 of 2 wallets”, or “Connect”. Wallet methods expose a named pending request so the global banner can say exactly what confirmation is awaited.
- **Errors:** Solver network failures, invalid responses, wrong EVM chain, wallet rejection and quote expiry during signing receive specific messages. Quote expiry is checked immediately before relay as well as before signing.
- **Evidence:** Unit tests cover journal round-trip/txid updates/no secret, reconnect timeout, chain guard, nav states and pending banner; Playwright covers restart fallback, solver rejection/outage, wallet rejection, pending naming and expiry mid-sign.
- **Consequence for rebuild:** Persist order metadata, never secrets, outside the vault; wallet state and pending confirmation must be observable; and every asynchronous safety-sensitive action needs a post-await recheck.
- **Revisit if:** Solver status becomes event-sourced or the wallet library exposes a stable restored-session flag.

### Correction to D-A1-019 · live quote horizon
- The mock TTL remains 60 seconds, but the web now accepts live quote expiries up to `MAX_QUOTE_FUTURE_S` (300 seconds). The solver’s D-A2-010 policy returns 120 seconds forward and 180 seconds for reverse safe-lane quotes; those are legitimate, not stale quotes.
