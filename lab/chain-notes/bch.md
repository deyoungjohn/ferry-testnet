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
