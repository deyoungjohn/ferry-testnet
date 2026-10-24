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

## 2026-10-22 · L3 EVM contract

- Chain id verified as `84532` via `cast chain-id --rpc-url https://sepolia.base.org`.
- Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; deployer, solver and user each hold 20.000000 USDC.
- Deployer `0x8138A3447485aA2613aD07d07123FdD623e48158`, solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70`, user `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd`; all have 0 ETH.
- Canonical CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` is present (69 bytes of code).
- Final predicted `FerryHTLC` address for salt `keccak256("ferry-htlc.v1")`: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`. Predicted from the final artifact with both `forge script` and `cast create2`.
- No Base Sepolia deployment or S-06 round-trip: the deployer and solver have no ETH. The user needs no ETH because the flow is permit + intent relayed by the solver; the solver still needs gas for `lockWithIntent` and `claim`.
- Source verification is not attempted: no BaseScan API key is present in `.env.local`.
