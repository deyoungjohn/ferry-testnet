# @ferry/core

Pure protocol functions and shared counter-chain types. No transports, wallets, storage, scripts or deployed-contract ABI. All token amounts are bigint base units. Parse untrusted terms with OrderTermsSchema/parseOrderTerms before use; JSON decimal strings must first be converted to bigint by the caller.

## Consumption

Development/test resolvers enable the `ferry-source` export condition. TypeScript inherits it from tsconfig.base.json. Vite consumers add it to resolve.conditions; Node/SSR test consumers also add it to ssr.resolve.conditions. A tsx process enables it with `--conditions=ferry-source` or NODE_OPTIONS. The source uses .js ESM specifiers, resolved to TypeScript by Vite/tsx. Ordinary production Node imports select dist after pnpm build. The no-build self-import test has been run with dist temporarily absent.

## Terms and encoding

OrderTerms v1 uses direction COUNTER_TO_BCH or BCH_TO_COUNTER, counterChain (the adapter id), counterNetworkId (numeric on EVM, network label on Solana/Tron), counterAsset (symbol, decimals, address), counterAmount, counterHtlc, userCounterAddress, solverCounterAddress and counterDeadline. BCH fields, hashLock and quote metadata retain the blueprint meaning. D-A2-003 contains the complete mapping. Runtime validation is strict at both object levels, rejects invalid byte lengths, addresses, nonpositive amounts and unknown fields, and normalizes EVM addresses and hex to lowercase. Address shape validation does not establish contract identity, chain existence, token decimals or route support; adapter configuration must verify those facts.

canonicalCBOR validates terms and implements the restricted RFC 8949 §4.2.1 profile: definite lengths, shortest unsigned integers, minimal tag-2 byte strings only above uint64, and map keys sorted lexicographically by their complete encoded bytes. Hash locks, BCH categories and BCH locking bytecodes are byte strings. All addresses, symbols, direction and textual IDs are UTF-8 text. Base58 case is preserved. Unicode is not normalized and unpaired surrogates are rejected. No floats, negatives, indefinite lengths or undefined fields can enter this profile. The small encoder is independently checked against cborg and committed forward/reverse/BSC fixtures. orderId is SHA-256 of these exact bytes.

signOrderId and verifyOrderSignature use EIP-191 personal-sign over the **32 raw bytes** of orderId, never its 66-character hex string. An injected OrderSigner owns signing; core never handles private keys. The verifier must use the trusted solver service EVM signing address from configuration, rather than an address supplied by an untrusted quote. On Solana/Tron that signing identity is separate from solverCounterAddress. assertHex32 performs representation validation only.

## Pricing

quoteExactIn evaluates the spread and USD fixed fee as one bigint rational expression and floors once into recipient base units. quoteExactOut computes the smallest payer base units whose exact-input quote covers the requested recipient amount, rounding up once. The lock pays exactly the requested amountOut; any excess implied by payer-unit rounding belongs to the solver. convertFloor/convertCeil operate on arbitrary validated decimal counts 0–36; real route metadata comes from verified adapters.

PricingPolicy.fixedFeeUsdMicros, checkLimits bounds, pegGuard prices/tolerance and reveal amounts/caps are integer millionths of one USD. Limits are inclusive and compare full rational input value, without first truncating to microdollars. pegGuard checks all supplied sources against $1 and their maximum disagreement; an empty list rejects quoting. The solver must reject missing required sources before calling it: PUSD needs issuer and spot evidence, MUSD needs spot evidence, and each counter asset needs its own guard. No price fetching occurs here. effectiveSpreadBps consumes a supplied signed BCH-inventory shortage signal, caps its magnitude and reverses its direction for BCH_TO_COUNTER. It cannot produce a negative spread.

## Timing and reveal

invariantF/R accept actual counter-lock time and BCH tip, immutable deadline terms and explicit configuration. erlangQuantile inverts the integer-shape Gamma CDF with a log-domain Poisson sum and bisection; see DLMF 8.4.8. It models independent exponential arrivals at the supplied mean, not chain halts, reorgs or ASERT dynamics. Shapes above 10,000 are rejected to bound computation. D-A2-004 records default margins and the unmeasured 60-second solver-reaction assumption. Reevaluate at the actual decision time. A passing probability model is not a guarantee during a halt.

revealPolicy is an additional gate after verifying the full lock against signed terms and checking timing. Inputs must describe the same live canonical transaction; a missing lock fails closed. Fast mode requires per-swap consent and the configured cap. BCH 0-conf requires an available clear DSProof feed and the complete observation window; one confirmation suffices for safe mode. Base requires configured confirmations, plus safe/finalized in safe mode; Ethereum safe mode requires finalized; Arbitrum uses observed inclusion age and safe/finalized for safe mode. Solana uses confirmed/finalized commitments. Arc/BSC conservatively require explicit finality in both lanes until L6 verification; Tron requires configured depth and solidification evidence (finalized=true). These non-Base route defaults mirror blueprint policy and remain provisional pending route probes.

## Adapters and EVM definitions

ChainAdapter methods document replay/idempotency and provisional/final behavior individually. LockEvent is at-least-once and includes stable eventId and removed retractions. Never log Claimed.secret. getLock/isFinal observations can change on reorg. Payloads are unknown adapter-owned values; callers must validate/narrow them. Interface presence does not implement a network client.

LOCK_INTENT_TYPES and LOCK_INTENT_TYPEHASH define the shared EIP-712 LockIntent. lockIntentTypedData binds name FerryHTLC, version 1, chain ID and verifying contract; lockIntentDomainSeparator exposes the domain hash. evmLockId uses keccak256 of ABI encoding address sender and bytes32 hashLock, without packed encoding. categoryDisplayToInternal/categoryInternalToDisplay reverse exactly 32 bytes; no script or BCH address construction is included. XV outputs are committed as cross-check.json and reported in the PR.

## Secret logging guard

The root ferry/no-secret-logging rule rejects secret/preimage identifiers in console or logger arguments, including nested payloads and optional logger calls. It is a name-based guard, not alias/data-flow analysis. Keep secrets out of logs, URLs, snapshots and analytics regardless of variable name. Fixtures test both violations and allowed public-field logging.
