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

