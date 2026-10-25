# Chain notes — ethereum

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-25 · L6 Ethereum Sepolia Deploy & S-14 Roundtrips

### Public RPC and Block Tags
- Tested RPC endpoints: `https://rpc.sepolia.org` (intermittent Cloudflare 522 timeouts) and `https://ethereum-sepolia-rpc.publicnode.com` (reliable and responsive).
- Chain ID: 11155111.
- Block tags: Both `safe` and `finalized` tags succeed on `eth_getBlockByNumber`. At block 11988155, `safe` block was 11988141 (~14 blocks behind tip, ~2.8 minutes) and `finalized` was 11988109 (~46 blocks behind, ~9.2 minutes representing Beacon chain 2-epoch finality).
- Event logs: `eth_getLogs` succeeds over 10,000 block ranges without rate limits.
- Block interval: ~12 seconds.

### Token Verification
- Circle Test USDC on Ethereum Sepolia:
  - Address: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (verified via Circle Developer Documentation).
  - Name: `USDC`, Symbol: `USDC`, Decimals: `6`, Version: `2`.
  - `DOMAIN_SEPARATOR()`: `0xb90e5057db141a932946e64d09ccb7ffc9b00bd79fec26f698d29af0c83320a6`.
  - EIP-2612 Permit: Supported.
- Ethereum Mainnet USDT (S-14 read-only fork verification):
  - Address: `0xdAC17F958D2ee523a2206206994597C13D831ec7`.
  - Name: `Tether USD`, Symbol: `USDT`, Decimals: `6`.
  - EIP-2612 Permit: Not supported (`DOMAIN_SEPARATOR()` and `permit()` revert).
  - Quirks: `transfer` and `transferFrom` return no value (0 bytes return data). Handled cleanly by OpenZeppelin `SafeERC20` in `FerryHTLC`. Verified via Anvil fork suite `test/S14UsdtMainnetFork.t.sol` (all 3 tests pass).

### Contract Deployment
- Canonical CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (69 bytes code).
- Deployment Transaction: `0x9c7f4563ce7cabbc7ad9f1ee0cdea1188f2e34b86c9de52edd8fbf26b0b10596` (block 11988079).
- Deployed Contract Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` (exact 3361 bytes code, byte-for-byte match with Base Sepolia).
- Gas Used: 5,520,829 (required explicit `--gas-limit 6000000` due to Prague storage deposit pricing).

### Live Round-Trip Execution (Circle USDC)
1. **Lock with Intent + Claim Round-Trip:**
   - User `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd` signed USDC EIP-2612 permit + EIP-712 `LockIntent`.
   - Solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70` relayed `lockWithIntent` and `claim`.
   - Lock Tx: `0xe06b8acc8acc8914514fb1e9d54f48f63e2c3f003d31012d50367047fd3be6e7` (block 11988107, gas used: 867,545).
   - Claim Tx: `0x1ee90d53baac2d90e8ad1469288226d833bf3b0f8100aaa2030291d6a9e81bd7` (block 11988107, gas used: 75,038).
   - Lock ID: `0xc7a2127a7cea0440018eef31dd2b53560a11b7504d25df15cf39c2121e7143bb`.
   - Final state: `Claimed` (2). User ETH unchanged, user USDC 40.0 → 40.0.
2. **Lock with Intent + Refund Round-Trip:**
   - Lock Tx: `0xfdb72832aae35877363766ec6d76af02686ee62a3c53194a6eb205e979e80ede` (block 11988162, gas used: 867,569, deadline: 1792898352, duration: 120s).
   - Refund Tx: `0xa0bf1b735adca98f60dd9fbf8420ac26e8dceb5e063fc5ebb00b84952b6646d8` (block 11988172, gas used: 71,666).
   - Lock ID: `0xc4fd1e9e66305ee2d105120a9a428fcf9fff9be0e81aab336535e8677f8fc4ac`.
   - Final state: `Refunded` (3). Full 1 USDC returned to user.
