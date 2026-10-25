# Chain notes — arbitrum

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-25 · L6 Arbitrum Sepolia Probe (S-13)

### Public RPC and Block Tags
- Tested RPC endpoint: `https://sepolia-rollup.arbitrum.io/rpc`.
- Chain ID: 421614.
- Block tags: Both `safe` and `finalized` tags succeed on `eth_getBlockByNumber`. At block 322570241, `safe` block was 322570241 (Nitro sequencer tip) and `finalized` was 322568774 (~1,467 blocks behind, representing Ethereum L1 batch finality).
- Event logs: `eth_getLogs` succeeds over 10,000 block ranges.
- Explorer: `https://sepolia.arbiscan.io`.

### Token Verification
- Arbitrum Sepolia Native USDC:
  - Address: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (verified via Circle Developer Documentation).
  - Symbol: `USDC`, Decimals: `6`.
  - EIP-2612 Permit: Supported. `DOMAIN_SEPARATOR()` is `0x85944e1292d007732838d6eadfa67589b78ffcededbd4df60488d0af251308bb`.
- Arbitrum Mainnet USDT (S-13):
  - Address: `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` (Tether USD, 6 decimals).
- Canonical CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (confirmed present on Arbitrum Sepolia).

### Deployment and Live Test Status
- Target CREATE2 Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`.
- Blocked on Funding: Deployer (`0x8138A3447485aA2613aD07d07123FdD623e48158`) and Solver (`0xC9ec91859Bdb598dC2eeE715934D8231478f7A70`) currently hold 0 ETH on Arbitrum Sepolia.
