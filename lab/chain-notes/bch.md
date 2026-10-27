# Chain notes — bch

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-22

### Chipnet Fulcrum Endpoints
- Tested `wss://chipnet.imaginary.cash:50004` over WebSocket Secure.
- Protocol handshake `server.version` with parameters `["FerryBalancesClient", "1.4"]` responds successfully with `["Fulcrum 2.1.4", "1.4"]`.
- `blockchain.headers.subscribe` returns block height 329042 with a valid 80-byte header hex.
- Address and scripthash methods: Both `blockchain.address.get_balance` and `blockchain.scripthash.get_balance` are supported by Fulcrum 2.1.4.
- CashTokens support: `blockchain.address.listunspent` returns `token_data` for any UTXO holding tokens (`category`, `amount`, `nft`).

### Address Derivation and Byte Order
- CashAddress testnet prefix is `bchtest`. Plain P2PKH addresses format as `bchtest:q…` (type `p2pkh`).
- Token-aware P2PKH addresses format as `bchtest:z…` (type `p2pkhWithTokens`). Both share the identical 20-byte public key hash (PKH).
- Verified derivation against Libauth documentation test vector (PKH `15d16c84669ab46059313bf0747e781f1d13936d` resolves to `bchtest:qq2azmyyv6dtgczexyalqar70q036yund53jvfde0x` and `bchtest:zq2azmyyv6dtgczexyalqar70q036yund5kclhrls4`).

### Chipnet Faucets
- `https://tbch.googol.cash/` active and operational. Offers a `chipnet` radio option with a simple arithmetic image captcha.
- Alternative: `https://chipnet.bch.ninja/faucet` and community Telegram bot `@tbch_bot`.

## 2026-10-23 · Phase L2 contract, token minting & S-07 probe

### CashTokens Minting (Genesis)
- Token category ID is defined by the outpoint transaction hash of input 0 when spending an outpoint with `vout === 0`.
- Minted two fungible test tokens on Chipnet from `SOLVER_BCH_WIF`:
  - **tPUSD**: Display category `ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac` (txid: `c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d`, supply 100,000,000.00 base units = 100M tokens at 2 decimals).
  - **tMUSD**: Display category `c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d` (txid: `4a540e2f13f28bc1297db79788f3a949c9e6ca823e00bcc4fe922dd2a106961d`, supply 100,000,000.00 base units = 100M tokens at 2 decimals).
- Solver token address holding minted supply: `bchtest:zz3r8kfgl8qs94pyswepj6dylqf5avuf9ygs8308u4`.

### S-07 Byte-Order Probe on Chipnet
- Tested byte order of CashTokens category parameter in `FerryHTLC.cash`:
  - **Display-order contract**: Funded in tx `72244904d3e778f606d0f264cde1e0b082abe5c762790c5b5156846b28e427d1`. Claim spend rejected by node mempool rules: `bad-txns-token-invalid-category (code 16)`.
  - **Internal-order contract**: Funded in tx `1d1d29b64fc13d76a6b859b953e4cbfc664807d139192459f94916df15e705ed`. Claim spend accepted and broadcast in tx `bc062c1ca46a5e9df8d2e7c66b1cf6f73cfdb8fae86f21ef054f8ce26bbccbc6` (376 bytes, 500 sats fee, 334 ms).
  - **Real Chipnet refund spend**: Funded in tx `2fdfd4ba122805657f044a92637bb77ab41692c32f5e4b1258585744586a7f54`. Refund spend broadcast at `locktime = 329143` in tx `0728ff6c8635f82ccf9912cbc2c6791a54d7fb907505887960125b1b6b688244` (341 bytes, 500 sats fee, 324 ms).

### Fulcrum CashTokens Quirk
- Fulcrum RPC `blockchain.scripthash.listunspent` defaults to `"exclude_tokens"`.
- Must pass the string include_tokens as the second parameter of the listunspent call to get CashTokens UTXOs back with their token_data field.

## 2026-10-24 · S-05 Fulcrum latency, DSProof & XO Engine evaluations

### Fulcrum Server Endpoints & Capabilities
Tested candidate endpoints on Chipnet and Mainnet (Mainnet read-only, no broadcasts):

| Host | Network | Transport | Server Version | Protocol | Genesis Hash | DSProof Support |
|---|---|---|---|---|---|---|
| `chipnet.imaginary.cash` | Chipnet | WSS (50004) | Fulcrum 2.1.4 | 1.4–1.6 | `000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b` | `blockchain.transaction.dsproof.subscribe` and `get` supported |
| `bch.imaginary.cash` | Mainnet | WSS (50004) | Fulcrum 2.1.4 | 1.4–1.6 | `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` | `blockchain.transaction.dsproof.subscribe` and `get` supported |
| `fulcrum.greyh.at` | Mainnet | WSS (50004) | Fulcrum 2.1.2 | 1.4–1.6 | `000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f` | `blockchain.transaction.dsproof.subscribe` and `get` supported |

### DSProof Protocol Methods
- `blockchain.transaction.dsproof.subscribe` accepts a single parameter: the 32-byte transaction hash hex. Returns `null` if no doublespend proof is currently known for the transaction, or the proof object if one exists. Registers the connection to receive push notifications when a doublespend proof matching the transaction is accepted by the node.
- `blockchain.transaction.dsproof.get` accepts a single parameter: the 32-byte transaction hash hex. Returns `null` if no proof exists, or the proof object if present.
- Both methods were verified functional on Fulcrum 2.1.2 and 2.1.4 on both networks.

### S-05 Chipnet Latency Benchmark (Broadcast to scripthash.subscribe Notification)
Measured using 10 sequential P2PKH self-spends on `wss://chipnet.imaginary.cash:50004`. The solver address scripthash was subscribed over WebSocket; each spend broadcasted a 300-sat fee transaction back to the solver wallet, timing round-trip to the incoming `blockchain.scripthash.subscribe` push notification:

| Sample | Transaction ID | Latency (ms) |
|---|---|---|
| 1 | `e519f97410aec640ff4b4d8e0f963c02dfae7e88b82f4723c4671dfa9777a24c` | 1372.1 |
| 2 | `28b0474f209e28798dfdce3f7a2a7db11a6875dd148e1339556043f125063480` | 925.3 |
| 3 | `111fd6b0ddcbd1dda03d8292c734cb4bd9cd227e4e23a30d9c80059e2a17c8ff` | 1131.7 |
| 4 | `2050afd1331ff3de2308275bc170cb35001a5f91b3caedfcd4e0fb66cc96e45d` | 1010.0 |
| 5 | `a19ee30dc308f848e25d07b36b90858eeffffae706fbf3cbda789b696baccb11` | 804.0 |
| 6 | `d8233a0b774b3fd788d33296aad16ef00ffa84e6a76e0ca1eca8a390fc93747d` | 1011.3 |
| 7 | `6580f9c5cdfd0474cd10a309866392e640576ad44010c1357895184892bfe420` | 1006.5 |
| 8 | `7213ca1ba10b9b08e7d333a6cee463852b2b87cd27f2bf8c94a19d41f3b77491` | 1146.3 |
| 9 | `30545903a9476336d513342d1d526b5135ea6a52705154fb59998d3143e4039b` | 1050.5 |
| 10 | `72f60834c35c24edc439e531cd3527fe64cab571ccb68aeeaffd85fbc76e5f77` | 1030.8 |

- **Minimum Latency:** 804.0 ms
- **Median Latency:** 1021.1 ms (acceptance threshold: < 2000 ms → PASS)
- **Maximum Latency:** 1372.1 ms
- **Tip subscription:** `blockchain.headers.subscribe` delivered current tip height (329336 on Chipnet, 974345 on Mainnet) instantaneously upon subscription.


## 2026-10-25 · BCH Lock Builder & Live Chipnet Verification (a team member)

- **Lock/Funding Transaction Builder (`buildLockTransaction`):**
  - Designed and added to `@ferry/htlc-bch`.
  - Supports deterministic coin selection via `selectLockInputs`: prioritises largest token UTXOs first, filters out any NFT-bearing UTXO or foreign category UTXO, and chooses the smallest sufficient single pure BCH UTXO (or smallest ascending subset) for miner fee and carry satoshis.
  - Automatically calculates exact token change (carrying 1000 satoshis dust limit) and BCH change.
  - Respects standard dust limits (546 satoshis): if remaining BCH change is less than 546 satoshis, it is absorbed into the miner fee rather than creating an unspendable dust output.
  - Dual output model:
    - Unsigned transaction formatted as Libauth `Transaction`, raw hex, and `WcSignTransactionRequest` (matching `@wizardconnect/*` / `@bch-wc2/interfaces` specifications for frontend wallet integrations).
    - Signed transaction generated with CashScript `SignatureTemplate` for solver and automated scripts when a private key or WIF is supplied.
- **Real Chipnet Run Verification:**
  - Funded user key (`USER_BCH_WIF`) from solver wallet with 500 tPUSD.
  - User locked 100 tPUSD into Ferry HTLC instance using `buildLockTransaction`.
  - Transaction broadcast and confirmed on Chipnet: `f52d67c794048bb56b24bf18d695683bea7916fc326f83714a67479057e81e73`.
  - HTLC token address: `bchtest:rvjn7gs3tmfkl2zng4xwlnmw6tjhg5eey782wx6qm9um0n30v7lgseahsw9u9`.
  - Recipient claimed the locked 100 tPUSD using `buildClaimTransaction` with 32-byte secret preimage.
  - Claim broadcast and confirmed on Chipnet: `fae826f20ef3717f7bcdb504beb1f5ddd9bed2537b9017f73189c5a8924bcd29`.
---

## 2026-10-25 · XO Hybrid Lock & Claim Verification

Live round-trip probe on Chipnet combining XO Engine template evaluation with CashScript spend execution (`packages/htlc-bch/src/probe-xo-hybrid.ts`).

### Lock Invitation & Bytecode Parity
- XO Engine imported `ferryHtlcTemplate` and created a lock invitation (`6172320baf1453e4951a2aa5b4dafa37`).
- Output locking bytecode was resolved via `engine.resolveInvitationOutputLockingBytecode` as `aa207253bf163d4bae2fff62603ec1f90c824cff68e6b4d37ca36ca8539eae858dfa87`.
- Byte-for-byte comparison with CashScript contract derivation (`deriveHtlcAddresses`) matched identically (S-02 Parity PASS).

### On-Chain Transactions
- **Lock Transaction:** Broadcast to Chipnet with transaction ID `f1d537078e1ebd0d218190a5b854c32c14114faa9b7518293c5d8bcde867afaf` (439 bytes). Funded 100 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) and 2000 satoshis carry into the XO-derived covenant P2SH32 output.
- **UTXO Confirmation:** Confirmed on Chipnet at output index 0 with exact token category, 100 base units, and 2000 satoshis carry.
- **Claim Transaction:** Built using CashScript `buildClaimTransaction` with secret preimage and broadcast to Chipnet with transaction ID `0a4e6ddbf0371e0dd8396d7c1cf49bd3a8c69e22b5711a763e74811e5482d2a3` (376 bytes). Confirmed on Chipnet with recipient receiving 100 tPUSD.

### XO Engine Workaround Assessment
- Testing `engine.buildInvitationTransactionFromMergedCommit` demonstrated that XO Engine can construct the unsigned wire transaction skeleton for the claim action (120 bytes, transaction hash `126922521cfe2e869137963d7efa2b0d3c4c635756dafebd603581b2fb5f8f41`).
- However, generating unlocking bytecode via `engine.generateUnlockingBytecode` fails with `InputUnspentOutputUnavailableError` because the public `Engine` class exposes no API to import external UTXOs into its internal tracking store, and `compileInputUnlockingScript` mandates local HD derivation key references.


---

## 2026-10-30 · Live Testnet Swaps On-Chain Evidence (E2E-01, E2E-03, E2E-04, E2E-03-safe)

All transactions verified on-chain via Chipnet Fulcrum indexers (`chipnet.imaginary.cash:50004`) and explorer `https://chipnet.imaginary.cash/tx/<txid>`.

### E2E-01 Forward Swap (USDC → tPUSD, Safe Lane, 2026-10-25)
- **Solver BCH Lock:**
  - TXID: `f9e6332bb496a6c46a74db6ec1a31ae358ace39b0d44be8e9f1376d0b9dd0901`
  - Output: 0.99 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) + 3000 satoshis carry to covenant P2SH32.
  - Explorer: `https://chipnet.imaginary.cash/tx/f9e6332bb496a6c46a74db6ec1a31ae358ace39b0d44be8e9f1376d0b9dd0901`
- **User BCH Claim:**
  - TXID: `62a242d5b81066dc68542f17a0e15e40251aede7c6e2300ebdb283f1901319ab`
  - Output: User token address receiving 0.99 tPUSD with secret preimage spend.
  - Explorer: `https://chipnet.imaginary.cash/tx/62a242d5b81066dc68542f17a0e15e40251aede7c6e2300ebdb283f1901319ab`

### E2E-03 Reverse Swap (tPUSD → USDC, Fast Lane, Wallet-Signed Lock, 2026-10-25)
- **User BCH Lock (`buildLockTransaction`):**
  - TXID: `e3abdac5beab5585a1e2d04e7ab5591d42c1837eeec493bc12e64eeb4df0bb5b`
  - Output: 1.00 tPUSD + 3000 satoshis carry locked into covenant P2SH32.
  - Explorer: `https://chipnet.imaginary.cash/tx/e3abdac5beab5585a1e2d04e7ab5591d42c1837eeec493bc12e64eeb4df0bb5b`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `8d1b8415513e4940e5cdb9b5528afe0fadf86c7b17b45283bf07573d1465dc4f`
  - Output: Solver token address claiming 1.00 tPUSD using secret extracted from Base Sepolia claim.
  - Explorer: `https://chipnet.imaginary.cash/tx/8d1b8415513e4940e5cdb9b5528afe0fadf86c7b17b45283bf07573d1465dc4f`

### E2E-04 Reverse Swap (tPUSD → USDC, Fast Lane, Manual Send, 2026-10-25)
- **User BCH Lock (Manual send to displayed P2SH32 address):**
  - TXID: `ded0ff8419d347f3e7ffd3a30ce6f119c40302dc1e2343c9e87fb356b20184d9`
  - Output: 1.00 tPUSD + 3000 satoshis carry locked into displayed covenant address.
  - Explorer: `https://chipnet.imaginary.cash/tx/ded0ff8419d347f3e7ffd3a30ce6f119c40302dc1e2343c9e87fb356b20184d9`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `9bea992c4b34a8fb4d6a9aeee2acabbe406d818eb524038f9873514b74a64ca7`
  - Output: Solver token address claiming 1.00 tPUSD using secret extracted from Base Sepolia claim.
  - Explorer: `https://chipnet.imaginary.cash/tx/9bea992c4b34a8fb4d6a9aeee2acabbe406d818eb524038f9873514b74a64ca7`

### E2E-03-safe Reverse Swap (tPUSD → USDC, Safe Lane with 1 Block Confirmation, 2026-10-25)
- **User BCH Lock (`buildLockTransaction`):**
  - TXID: `f073a14bd557f8c39bc82d6c1cfae00b3f14840ade6ca660a819fbc328720f13`
  - Output: 1.00 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) + 3000 satoshis carry locked into covenant P2SH32.
  - Confirmation: Mined in Chipnet block `329463` (1 confirmation verified before solver EVM counter-lock).
  - Explorer: `https://chipnet.imaginary.cash/tx/f073a14bd557f8c39bc82d6c1cfae00b3f14840ade6ca660a819fbc328720f13`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `84f41d3add1822a3ca99d13475535e6055ef71b5bc1866bbda8569855bea4e8c`
  - Output: Solver token address claiming 1.00 tPUSD using secret preimage revealed on Base Sepolia.
  - Explorer: `https://chipnet.imaginary.cash/tx/84f41d3add1822a3ca99d13475535e6055ef71b5bc1866bbda8569855bea4e8c`

---

## 2026-10-26 · Live Swaps On-Chain Evidence against localhost:8787 solver

Executed end-to-end against live solver daemon running on `localhost:8787` (`pnpm dev:solver`) with funded human wallets.

### Forward Swap (USDC → tPUSD, Safe Lane, Order `0x843bae146bbac9ed29ff3299b2f84e3615dc75b599c02060aa7d272d5b6f16ea`)
- **Solver BCH Lock:**
  - TXID: `994ab56fbe5dd4d2e89c4242ac456613957415d319d62c7c241b43e6d4480da2`
  - Output: 0.94 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) + 3000 satoshis carry locked into covenant P2SH32.
  - Explorer: `https://chipnet.imaginary.cash/tx/994ab56fbe5dd4d2e89c4242ac456613957415d319d62c7c241b43e6d4480da2`
- **User BCH Claim:**
  - TXID: `3de6b1d68b91b29f0275f8bb1dd46ce5f7843c52ef529d6f7bee36a47073fb67`
  - Output: User token address receiving 0.94 tPUSD with secret preimage spend.
  - Explorer: `https://chipnet.imaginary.cash/tx/3de6b1d68b91b29f0275f8bb1dd46ce5f7843c52ef529d6f7bee36a47073fb67`

### Reverse Swap (tPUSD → USDC, Order `0xa71a3bf75579046c8ae3d93c81a3c92fd836eea3b695bf9dc0958b107d46d9ab`)
- **User BCH Lock (`buildLockTransaction`):**
  - TXID: `b02c888aeeaa3a9c01b67227f0f631f89c9ca449443e6e4aa4e65bd261c19f0a`
  - Output: 1.00 tPUSD + 3000 satoshis carry locked into covenant P2SH32.
  - Explorer: `https://chipnet.imaginary.cash/tx/b02c888aeeaa3a9c01b67227f0f631f89c9ca449443e6e4aa4e65bd261c19f0a`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `dc353eb0e06daa4d23c5bb8380a53eb7e886c64538057dafcfda05354e147ef6`
  - Output: Solver token address claiming 1.00 tPUSD using secret preimage revealed on Base Sepolia.
  - Explorer: `https://chipnet.imaginary.cash/tx/dc353eb0e06daa4d23c5bb8380a53eb7e886c64538057dafcfda05354e147ef6`

---

## 2026-10-26 · BCH Claim Detection Latency Analysis & Reconciliation Safety Net

### 1. Root Cause Analysis of 7-Minute Stalled Swap (Order `0xee9a1baa…`)
Timestamps extracted from solver SQLite database and Chipnet block explorer:
- **Order creation:** 17:53:35 UTC (`1793037215894`)
- **Solver BCH lock broadcast:** 17:54:25 UTC (`1793037265293`, TXID `f173cf8a01b8245e11e7a9a8c472107dd1fef2d64db9d03a074cdbfa7d64a938`)
- **User claim broadcast:** ~18:00:30 UTC (TXID `07390a3e2af054c7b1433ad2b68502c10ad5d52b96508a4cc140c38e542a10ad`)
- **User claim mined on Chipnet:** blocktime 18:00:50 UTC (`1793037650`, block 329636)
- **Solver secret extracted & EVM claim broadcast:** 18:00:32 UTC (`1793037632012`, TXID `0x65a9754452c20e417356372516d7bc5fbe8285833c6970b779c1afda44484f06`)
- **Order completed (DONE):** 18:00:40 UTC (`1793037640877`)

**Findings:**
1. **Confirmation Depth:** The solver does **not** wait for confirmation depth (mined block). It accepted the user claim with `height = 0` (mempool), broadcasting the EVM claim at 18:00:32 UTC, 18 seconds before the block was mined at 18:00:50 UTC.
2. **Missing History Reconciliation:** The solver previously had `reconcileOrders()` running only once at startup. During active execution, `processOrder()` only watched for the refund height when in `SOLVER_LOCK_SEEN` and did not actively poll `getHistory()`. It was solely dependent on either WebSocket push notifications (`blockchain.scripthash.subscribe`) or the client's cooperative `submitSecret` endpoint.
3. **Client Handoff Failure:** The web UI's `handleClaim` button threw an error on second click ("already in block chain") and aborted `submitSecret`, so the solver never received the cooperative secret.
4. **Reconciliation Safety Net:** Added continuous 2-second background history reconciliation in `runner.pollInterval`. If any WebSocket notification is dropped or delayed, the engine automatically checks `findClaimInHistory` and advances within 2 seconds.
5. **EVM Claim Idempotency:** Guarded `processSolverClaim` with `inFlightClaims` set and added pre-check / error catch on `evmAdapter.getLock` to adopt already-claimed locks and eliminate `NotLocked()` reverts.

### 2. Measured Detect-to-Broadcast Latencies
- **Live swap `0x843bae14…` (with live WebSocket notification):**
  - User BCH claim in mempool: 17:53:26 UTC (`1793037206000`)
  - Solver EVM claim broadcast: 17:53:26.552 UTC (`1793037206552`)
  - Latency: **552 ms**
- **Hermetic test with dropped WebSocket notification (`bch-claim-reconciliation.test.ts`):**
  - WebSocket notification suppressed completely: `subscriptionCallback` never invoked
  - Periodic reconciliation detected user claim in mempool `height = 0`
  - Secret extracted & EVM claim broadcast within **1 ms** of reconciliation pass
  - Swap transitioned cleanly to `SOLVER_CLAIM_BROADCAST`

---

## 2026-10-27 · Live Swaps Evidence: Reverse Path Proof & Web UI Implementation Requirements

Executed end-to-end against live solver daemon running on `localhost:8787` (`pnpm dev:solver`) with testnet keys from root `.env.local`.

### 1. Fast Lane Reverse Swap (0-conf Opt-In, Gasless Relay Claim, Order `0x255b822037ea39e01b3da225f13f2880e7d9b42845e7b5d0f023f469ae8cb5a8`)
- **User BCH Lock (`buildLockTransaction`):**
  - TXID: `6537b5b334a4cbdfb927da007c762748e88e9b782aef9a174763e00a877d4e0e`
  - Output: 1.00 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) + 3000 satoshis carry locked into covenant P2SH32.
  - Explorer: `https://chipnet.imaginary.cash/tx/6537b5b334a4cbdfb927da007c762748e88e9b782aef9a174763e00a877d4e0e`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `699fabae8a4e98014e0984ef971fe456bd894b2c50e81010524d9d11c6c3cf61`
  - Output: Solver token address claiming 1.00 tPUSD using secret preimage revealed on Base Sepolia.
  - Explorer: `https://chipnet.imaginary.cash/tx/699fabae8a4e98014e0984ef971fe456bd894b2c50e81010524d9d11c6c3cf61`
- **Total Duration:** 19.01s (Fast lane 0-conf on BCH).

### 2. Safe Lane Reverse Swap (1-Conf BCH, Direct Contract Claim, Order `0x947d75bd270d4488eb0812eab8d5bb7d63d96b2d31afef5ec95215f25d79744d`)
- **User BCH Lock (`buildLockTransaction`):**
  - TXID: `7a015d04d3bf01f425e8b38045b1d3e2b9b3756aa7735f01bc77bdfcf6545ed5`
  - Output: 1.00 tPUSD (`ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac`) + 3000 satoshis carry locked into covenant P2SH32.
  - Confirmation: Mined in Chipnet block `329694` (1 confirmation verified before solver EVM counter-lock).
  - Explorer: `https://chipnet.imaginary.cash/tx/7a015d04d3bf01f425e8b38045b1d3e2b9b3756aa7735f01bc77bdfcf6545ed5`
- **Solver BCH Claim (`buildClaimTransaction`):**
  - TXID: `9a08e90c884553c073f9e6ba8fd7cde0b2e8bd0ef1d25c61f5860de1c0a86121`
  - Output: Solver token address claiming 1.00 tPUSD using secret preimage revealed via direct EVM claim on Base Sepolia.
  - Explorer: `https://chipnet.imaginary.cash/tx/9a08e90c884553c073f9e6ba8fd7cde0b2e8bd0ef1d25c61f5860de1c0a86121`
- **Total Duration:** 642.95s (~10.7 mins, mostly waiting for Chipnet block 329694).

### 3. Web UI Differences and Implementation Requirements ( Report)
1. **Direct EVM Claim `lockId` Calculation:**
   - In EVM contracts, `lockId` is computed as `keccak256(abi.encode(msg.sender, hashLock))`.
   - In reverse swaps, the EVM counter-lock was broadcast by the **solver** (`terms.solverCounterAddress`), making the solver the lock's `sender`.
   - When the user wallet directly executes `FerryHTLC.claim(lockId, secret)`, it **MUST NOT** pass the Ferry protocol `orderId` (which reverts with `NotLocked() (0x1834e265)`).
   - Instead, the web UI must compute:
     `keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [terms.solverCounterAddress, terms.hashLock]))`.
2. **Gasless Relay Claim (`POST /v1/orders/:id/relay-claim`):**
   - In the gasless relay path, the solver automatically calculates `expectedLockId` from `terms.solverCounterAddress`, submits the EVM claim, and pays the Base gas fee.
   - This provides the smoothest UX: user needs zero Base ETH to complete the reverse swap.
3. **BCH Lock UTXO Selection & Carry Satoshis:**
   - The user must provide both CashTokens of category `tPUSD` and satoshis for carry (`terms.bchCarrySats = 3000n`), plus sufficient satoshis to cover miner fees (~500 - 1500 sats).
   - If the user wallet lacks a separate pure satoshi UTXO or has insufficient sats alongside the token UTXO, `buildLockTransaction` will throw `Insufficient token / satoshi balance`.
