# Chain notes — bch

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

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
- Must supply `"include_tokens"` as second parameter: `client.request("blockchain.scripthash.listunspent", [scripthash, "include_tokens"])` to return CashTokens UTXOs with `token_data`.
