# @ferry/solver (Ferryman)

Ferryman is the autonomous solver daemon for Ferry. It watches supported chains, calculates quotes with peg-guard and timing invariant protections, manages HTLC state machines across both EVM and BCH, and persists action intents ahead of broadcast with WAL-mode SQLite.

## Architecture

1. **State Machine (`src/state-machine/`):**
   - Pure transition table (`transition(order, event)`) modeling all forward flow edges (`QUOTED` -> `USER_LOCK_SEEN` -> `USER_LOCK_FINAL` -> `SOLVER_LOCK_BROADCAST` -> `SOLVER_LOCK_SEEN` -> `SECRET_KNOWN` -> `USER_CLAIM_SEEN` -> `SOLVER_CLAIM_BROADCAST` -> `SOLVER_CLAIM_FINAL` -> `DONE`), along with abort paths (`EXPIRED`, `REJECTED`, `SOLVER_REFUNDED`).
   - Idempotent and pure to facilitate table testing and deterministic reconciliation.
   - Rejection reasons tracked explicitly in DB (`rejection_reason`) when terms, deadlines, or invariant F fail.

2. **Persistence (`src/db/`):**
   - SQLite backed by `better-sqlite3` configured in Write-Ahead Logging (`WAL`) mode with `NORMAL` synchronous mode for high-throughput concurrency and crash resilience.
   - Dual table schema: `orders` holds canonical terms, status, txids, secrets, and `needs_attention` flag; `actions` enforces unique `(orderId, action)` constraints so action intents are logged _before_ broadcast and updated with txids after broadcast.
   - Unexpected state combinations during startup reconciliation are marked `needs_attention: 1` rather than silently swept into DONE.

3. **BCH Quorum Client & Real Lock Builder (`src/bch/`):**
   - Dual-Fulcrum WebSocket client connecting to independent chipnet nodes (`wss://chipnet.imaginary.cash:50004` and `wss://blackie.c3-soft.com:50004`).
   - Enforces a tip quorum where server tips must agree (`|tip1 - tip2| <= 1`).
   - Automatically handles reconnects and performs history reconciliation via `blockchain.scripthash.get_history` (CH-02 / CH-04).
   - Real BCH lock transactions assembled with CashScript `TransactionBuilder`, funding P2SH32 contract outputs with CashTokens and sats, signed with `SOLVER_BCH_WIF`.
   - Automatic secret extraction from user claim transaction unlocking scripts, verifying `sha256(secret) === hashLock`.

4. **Quote API (`src/api/`):**
   - Fastify HTTP service exposing:
     - `POST /v1/quotes`: Validates bounds ($1.00-$50.00), checks peg health via `PriceSource`, computes quote via integer math, checks timing invariant F at quote time, and returns EIP-191 signed `orderId`.
     - `GET /v1/orders/:id`: Returns order status, deadlines, and optional `bchLock` details ({ txid, vout, satoshis }). **Strict privacy enforcement:** never returns secret unless it has already appeared public on chain in a confirmed claim.
     - `POST /v1/orders/:id/secret`: Validates cooperative secret reveal against hashLock and reveal policy.
     - `POST /v1/orders/:id/relay-lock`: Relays gasless user locks via `lockWithIntent`.
     - `POST /v1/orders/:id/relay-claim`: Relays gasless user claims on EVM counter-locks (solver pays gas, recovered in the spread). Validates secret against hashLock and triggers solver BCH token claim.
     - `GET /v1/health`: Reports node tip heights, tip ages, inventory, and quoting status (automatically disables quoting if tip ages exceed thresholds).

5. **Reverse Direction Engine (`BCH_TO_COUNTER`):**
   - Inverts the chains' roles over the shared `ORDER_STATUSES` state machine:
     - User locks CashTokens on BCH (supports both wallet and manual QR funding routes). The engine watches the P2SH32 covenant address, matching category, amount, and satoshi carry -> `USER_LOCK_SEEN` -> `USER_LOCK_FINAL`.
     - At counter-lock time $t_0$, the engine asserts quote expiry and validates timing invariant R ($n = \text{bchRefundHeight} - \text{currentTip} \ge 108$). If either check fails, the order transitions to `REJECTED`.
     - Solver counter-locks on EVM via `evmAdapter.lock` -> `SOLVER_LOCK_BROADCAST` -> `SOLVER_LOCK_SEEN`.
     - User claims EVM funds directly or via `POST /v1/orders/:id/relay-claim` -> `USER_CLAIM_SEEN` with secret revealed.
     - Solver claims user's BCH covenant with `buildClaimTransaction` under the shared write-ahead routine (`SOLVER_CLAIM`) -> `SOLVER_CLAIM_BROADCAST` -> `SOLVER_CLAIM_FINAL` -> `DONE`.
     - Abort edges: user funds after expiry or invariant R fails (`REJECTED`, user refunds BCH by height); user abandons without EVM claim (`counterDeadline` passes, solver refunds EVM lock via `evmAdapter.refund` -> `SOLVER_REFUNDED`).

6. **Engine Runner & Chain Watchers (`src/engine/`):**
   - Actively subscribes to `evmAdapter.watch` and `bchClient.subscribeScriptHash` to drive events into the state machine.
   - Enforces timing invariant F and quote expiry check at counter-lock time ($t_0$) before broadcasting solver BCH lock.
   - Safe lane reveal policy validation before triggering counter-claims.
   - Startup reconciliation re-deriving unfinalized orders directly from EVM contract state and BCH UTXO history.

## Configuration

Configured through environment variables (defaults match `.env.example` exactly):

- `NETWORK` (default: `testnet` - maps `BASE_SEPOLIA_...` and `BCH_CHIPNET_...`)
- `PORT` (default: `8787` per the port allocation)
- `HOST` (default: `127.0.0.1`)
- `DATABASE_PATH` (default: `:memory:` or path to `data/solver.db`)
- `BCH_ELECTRUM_URLS` / `BCH_CHIPNET_ELECTRUM_URLS` (comma-separated Fulcrum WebSocket endpoints)
- `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` (EVM JSON-RPC URL)
- `BASE_CHAIN_ID` / `BASE_SEPOLIA_CHAIN_ID` (EVM chain ID, default: `84532`)
- `BASE_FERRY_HTLC_ADDRESS` / `BASE_SEPOLIA_FERRY_HTLC_ADDRESS` (deployed FerryHTLC address)
- `BASE_USDC_ADDRESS` / `BASE_SEPOLIA_USDC_ADDRESS` (Circle USDC address)
- `SOLVER_EVM_PRIVATE_KEY` (solver EVM wallet private key)
- `SOLVER_BCH_WIF` (solver Chipnet WIF)
- `TPUSD_CATEGORY` (CashTokens tPUSD category on Chipnet)
- `SPREAD_BPS` (default: `40`)
- `FIXED_FEE_USD` (default: `0.05`)
- `MIN_SWAP_USD` (default: `1.00`)
- `MAX_SWAP_USD` (default: `50.00`)
- `MAX_EXPOSURE_USD` (default: `250.00`)
- `TIP_MAX_AGE_BASE_SECONDS` (default: `60`)
- `TIP_MAX_AGE_BCH_SECONDS` (default: `7200`)

## Running Locally

Run the daemon:

```bash
pnpm --filter @ferry/solver start
```

Run test suite:

```bash
pnpm --filter @ferry/solver test
```

Run live Chipnet/Base Sepolia scripts (requires `.env.local` keys and funded balances):

```bash
# Real 4-tx forward swap against live networks
pnpm --filter @ferry/solver live:swap

# Real 4-tx reverse swaps against live networks (E2E-03 & E2E-04)
pnpm --filter @ferry/solver live:reverse

# 10-swap reaction latency benchmark across live Fulcrum
pnpm --filter @ferry/solver live:latency
```

Build distribution bundle:

```bash
pnpm --filter @ferry/solver build
```

## Hardening & Safety Guarantees

- **Crash Recovery & Single-UTXO Invariant:** Before broadcasting any BCH counter-lock, refund, or claim, the solver engine pre-computes the signed transaction hex and txid and persists a write-ahead intent record in SQLite (`executeOrAdoptBchTx`). If the daemon crashes or is killed via `SIGKILL` before or after broadcast, restart reconciliation checks on-chain history: if the transaction was already mined, it adopts it without broadcasting; if not yet seen, it rebroadcasts the identical pre-signed hex, ensuring exactly one transaction UTXO is ever created on-chain.
- **EVM Check-Then-Act vs BCH Write-Ahead:** In contrast to raw BCH transactions that require local byte persistence to avoid duplicate UTXO spends, EVM on-chain state (`getLock`) is authoritative and atomic. The engine uses check-then-act with Viem for EVM locks, claims, and refunds (D-A2-008).
- **Order Lookup by Lock ID:** Orders are indexed and looked up by composite EVM lock id (`keccak256(owner, hashLock)`). An SQLite unique constraint on `(user_counter_address, hash_lock)` prevents duplicate orders or quote collision between users sharing a hashLock.
- **Solver BCH Refund:** Implements the §5.3 abort edge: if a user locks on EVM and solver locks on BCH, but the user abandons without claiming by `bchRefundHeight`, the solver automatically builds and broadcasts a covenant refund transaction via `@ferry/htlc-bch` `buildRefundTransaction`.
- **Healthy Quorum Tip Requirement:** The solver never uses hardcoded block heights. If the Fulcrum quorum is unhealthy or the tip is unknown, the engine refuses counter-locking (stays in `USER_LOCK_FINAL`) and API returns 503 on quote requests.
