# @ferry/solver (Ferryman)

Ferryman is the autonomous solver daemon for Ferry. It watches supported chains, calculates quotes with peg-guard and timing invariant protections, manages HTLC state machines across both EVM and BCH, and persists action intents ahead of broadcast with WAL-mode SQLite.

## Architecture

1. **State Machine (`src/state-machine/`):**
   - Pure transition table (`transition(order, event)`) modeling all forward flow edges (`QUOTED` -> `USER_LOCK_SEEN` -> `USER_LOCK_FINAL` -> `SOLVER_LOCK_BROADCAST` -> `SOLVER_LOCK_SEEN` -> `SECRET_KNOWN` -> `USER_CLAIM_SEEN` -> `SOLVER_CLAIM_BROADCAST` -> `SOLVER_CLAIM_FINAL` -> `DONE`), along with abort paths (`EXPIRED`, `REJECTED`, `SOLVER_REFUNDED`).
   - Idempotent and pure to facilitate table testing and deterministic reconciliation.

2. **Persistence (`src/db/`):**
   - SQLite backed by `better-sqlite3` configured in Write-Ahead Logging (`WAL`) mode with `NORMAL` synchronous mode for high-throughput concurrency and crash resilience.
   - Dual table schema: `orders` holds canonical terms, status, txids, and secrets; `actions` enforces unique `(orderId, action)` constraints so action intents are logged _before_ broadcast and updated with txids after broadcast.

3. **BCH Quorum Client (`src/bch/`):**
   - Dual-Fulcrum WebSocket client connecting to independent chipnet nodes (`wss://chipnet.imaginary.cash:50004` and `wss://blackie.c3-soft.com:50004`).
   - Enforces a tip quorum where server tips must agree (`|tip1 - tip2| <= 1`).
   - Automatically handles reconnects and performs history reconciliation via `blockchain.scripthash.get_history` (CH-02 / CH-04).

4. **Quote API (`src/api/`):**
   - Fastify HTTP service exposing:
     - `POST /v1/quotes`: Validates bounds ($5-$250), verifies peg health, computes quote via integer math, validates timing invariant F, and returns EIP-191 signed `orderId`.
     - `GET /v1/orders/:id`: Returns order status and deadlines. **Strict privacy enforcement:** never returns secret unless it has already appeared public on chain in a confirmed claim.
     - `POST /v1/orders/:id/secret`: Validates cooperative secret reveal against hashLock and reveal policy.
     - `POST /v1/orders/:id/relay-lock`: Relays gasless user locks via `lockWithIntent`.
     - `GET /v1/health`: Reports node tip heights, tip ages, inventory, and quoting status (automatically disables quoting if tip ages exceed thresholds).

5. **Engine Runner (`src/engine/`):**
   - Manages startup reconciliation re-deriving unfinalized orders directly from EVM contract state and BCH UTXO history.
   - Measures detect-to-broadcast reaction latency for on-chain actions.

## Configuration

Configured through environment variables:

- `PORT` (default: `8787` per the port allocation)
- `HOST` (default: `127.0.0.1`)
- `DATABASE_PATH` (default: `:memory:` or path to `data/solver.db`)
- `BCH_ELECTRUM_URLS` (comma-separated Fulcrum WebSocket endpoints)
- `BASE_RPC_URL` (EVM JSON-RPC URL)
- `BASE_CHAIN_ID` (EVM chain ID, e.g. 31337 or 84532)
- `BASE_FERRY_HTLC_ADDRESS` (deployed FerryHTLC address)
- `BASE_USDC_ADDRESS` (Circle USDC address)
- `SOLVER_EVM_PRIVATE_KEY` (solver EVM wallet private key)
- `TPUSD_CATEGORY` (CashTokens tPUSD category on Chipnet)
- `SPREAD_BPS` (default: 50)
- `FIXED_FEE_USD` (default: 0.10)
- `MIN_SWAP_USD` (default: 5.00)
- `MAX_SWAP_USD` (default: 250.00)
- `TIP_MAX_AGE_BASE_SECONDS` (default: 60)
- `TIP_MAX_AGE_BCH_SECONDS` (default: 7200)

## Running Locally

Run unit and integration test suites:

```bash
pnpm --filter @ferry/solver test
```

Build distribution bundle:

```bash
pnpm --filter @ferry/solver build
```
