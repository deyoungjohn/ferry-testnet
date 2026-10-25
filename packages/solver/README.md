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
     - `GET /v1/health`: Reports node tip heights, tip ages, inventory, and quoting status (automatically disables quoting if tip ages exceed thresholds).

5. **Engine Runner & Chain Watchers (`src/engine/`):**
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

Build distribution bundle:

```bash
pnpm --filter @ferry/solver build
```
