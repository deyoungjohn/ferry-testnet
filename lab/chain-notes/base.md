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

## 2026-10-24 · L3 deploy and headless S-06

- The earlier 2026-10-22 note is superseded: all four wallets were funded with 0.1 Base Sepolia ETH before this run. Deployer `0x8138A3447485aA2613aD07d07123FdD623e48158`, solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70`, user `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd`.
- **Deploy:** `0xa47e4d4610f2f6c3021226e8ecef3cc54d1816afdf4fb151f2134c321694e958`, block `49759583`, gas used `804543`, effective gas price `0.006 gwei`, fee `0.000004827258 ETH`. Contract `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` matches the prediction; deployed code is 3361 bytes.
- **S-06 headless:** user `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd` signed the Circle USDC permit and the `LockIntent`; solver relayed `lockWithIntent` and then `claim`.
  - Lock tx `0xbba4e04bfc90ead21bcb310c801ad3e43a324815399a021f9659d63b6441b2e1`, block `49760315`, gas `258429`, fee `0.000001550574 ETH`.
  - Claim tx `0xd8f79ebce2dab331863ac021762b17d8356c436fde07537295a334d163679dc1`, block `49760315`, gas `61708`, fee `0.000000370248 ETH`.
  - Lock id `0x303cc6f9b751456c3d7d96b9262f763b9707b6b44892ba65723a0c61ece72b84`; hashLock `0x2e85591f1ba862c40ecd8f564f71fb0762fe7cb7f024d7fa5f465b32a1fd4801`; final state `Claimed` (2).
  - User ETH unchanged at `0.1 ETH`; user USDC `40.000000 → 40.000000`; solver paid `0.000001920822 ETH` total. Contract balance returned to zero.
- No metrics row: this was a contract-level lock/claim, not a quoted swap route; gas and fees are recorded here instead.
- BaseScan verification is still blocked: no explorer API key in `.env.local`. The deployment and round-trip used testnet funds only.
