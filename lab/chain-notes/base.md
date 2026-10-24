# Chain notes — base

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-22

### Public RPC and Block Tags
- Tested public Base Sepolia endpoint: `https://sepolia.base.org`.
- Chain ID: 84532.
- Block tags: Both `safe` and `finalized` tags succeed on `eth_getBlockByNumber`. At tip block 48900919, the `safe` block was 48900675 (~244 blocks behind tip, ~8 minutes) and `finalized` was 48895456 (~5,463 blocks behind, representing L1 Ethereum finality).
- Event logs: `eth_getLogs` succeeds over block ranges with contract address filters.

### Circle USDC On-Chain Contract Parameters
- Contract address: `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (verified via Circle Developer Documentation).
- `name()`: `USDC`
- `symbol()`: `USDC`
- `decimals()`: `6`
- `version()`: `2` (FiatTokenV2 / EIP-2612 permit implementation)
- `DOMAIN_SEPARATOR()`: `0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818` (matches EIP-712 structured data domain for Base Sepolia chain ID 84532).

### Faucets
- Base Sepolia ETH: Optimism Superchain Faucet (`https://console.optimism.io/faucet`) and Coinbase Developer Platform faucet (`https://portal.cdp.coinbase.com/products/faucet`).
- Base Sepolia USDC: Circle official testnet faucet (`https://faucet.circle.com/`), dispenses 10 USDC per request with a 2-hour cooldown.

