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

---

## 2026-10-26 · Arbitrum Sepolia CREATE2 Deployment & Live S-13 Roundtrips

### Contract Deployment
- Target & Deployed Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` (byte-for-byte 6,724 hex chars code match across Base Sepolia, Ethereum Sepolia, and Arc).
- Canonical CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
- Deploy Transaction: `0xe2fe9040a7848a3eb318d68a5b1bc3042adc645a8b8c9cabae27f9ac25d9d010` (Block 323003837).
- Gas Used: 804,543 (effective gas price: 0.0201 gwei, fee: 0.000016 ETH).

### Live Round-Trip Execution (Arbitrum Sepolia Circle USDC)
1. **Lock with Intent + Claim Round-Trip:**
   - User `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd` signed USDC EIP-2612 permit + EIP-712 `LockIntent`.
   - Solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70` relayed `lockWithIntent` and `claim`.
   - Lock Tx: `0x44de1a6dfe7c45b2cb2f7dbb4fa2a503f3e1ae4469d35a5852baaf6f6290e51d` (Block 323004245, gas used: 258,429).
   - Claim Tx: `0xcba0c331e71f5da8f92d8dc6d71ce02ff8087def1496f5f70032c78d6dfc2631` (Block 323004256, gas used: 61,720).
   - Lock ID: `0x718414a2a15ca9fa3af626597aa1e1cefb25256d78415d6be5806c5ecba35a6d`.
   - Final state: `Claimed` (2). User ETH balance remained 0 (gasless user experience confirmed).
2. **Lock with Intent + Refund Round-Trip:**
   - Lock Tx: `0x843a3734b22870f889c45eaf1ea7a185b88457a2d7a9518bcf5687f237a416a8` (Block 323004423, deadline: 1793013801, duration: 120s).
   - Refund Tx: `0xb170e3b0ad948a07473889e21d3035440a2b589c11a0ee8215ccf21607c17c4f` (Block 323004896).
   - Lock ID: `0x6f03d7fccd8ce7c36076b1f7b36834b552883a78a48ac9bc6b5ca442e2d9550b`.
   - Final state: `Refunded` (3). Full 1 USDC returned to user (user balance 19 USDC -> 20 USDC).

