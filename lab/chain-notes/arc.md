# Chain notes — arc

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-25 · L6 Arc Testnet Deploy & S-08 Roundtrips

### Public RPC and Block Tags
- Tested RPC endpoint: `https://rpc.testnet.arc.io`.
- Chain ID: 5042002.
- Block tags: Both `safe` and `finalized` tags succeed on `eth_getBlockByNumber`. Arc operates single-slot deterministic finality; at block 68966132, both `safe` and `finalized` match the tip block exactly.
- Block interval: ~1-2 seconds.
- Event logs: `eth_getLogs` succeeds over 1,000+ block ranges.
- Explorer: `https://testnet.arcscan.io`.

### Native USDC and Consensus Precompiles
- Gas Token: USDC is the consensus native gas token (represented in 18 decimals in balances/fees: 1 USDC = `10^18` wei).
- ERC-20 Interface: Contract at `0x3600000000000000000000000000000000000000` provides ERC-20 standard interface with 6 decimals (1 USDC = `10^6` units).
  - Implementation: `0xC6AD664ac6679F4Ce74e10E91449C93Ec1ae3cA6`.
  - Name: `USDC`, Symbol: `USDC`, Decimals: `6`.
  - EIP-2612 Permit: Supported. `DOMAIN_SEPARATOR()` is `0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0`.
- Custom Node Precompiles:
  - `0x1800000000000000000000000000000000000001`: `isBlocklisted(address) returns (bool)` checks blocklisted addresses.
  - `0x1800000000000000000000000000000000000000`: native balance state updater.
  - Simulation quirk: Foundry revm local simulator throws `StackUnderflow` because it lacks custom Arc precompile bytecode. Solved by mocking both addresses via `vm.etch` during script simulation and passing `--skip-simulation` on broadcast.

### Contract Deployment
- Canonical CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (69 bytes code).
- Deployment Transaction: `0x366257dd717e683df21e9a9f36b994097f4e8a018c6132b2088c2c4199d4e3b3` (block 68961730).
- Deployed Contract Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` (exact 3361 bytes code, byte-for-byte match with Base Sepolia).
- Gas Used: 789,951.

### Live Round-Trip Execution (S-08)
1. **Lock with Intent + Claim Round-Trip:**
   - User `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd` signed USDC EIP-2612 permit + EIP-712 `LockIntent`.
   - Solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70` relayed `lockWithIntent` and `claim`.
   - Lock Tx: `0x190ffcd934bada685e8c00739dd95d7c065b951c5d054b47bdb78b3a490cb87b` (block 68964844, gas used: 244,823).
   - Claim Tx: `0x78c8511fb73243c502c954be1166701cf362964127cfd87b6bcabaf328424cdd` (block 68964848, gas used: 72,411).
   - Lock ID: `0xcd3f73778a219e350cab040c3214187a6770cc461f1482c44ab81e2d82b5aa1c`.
   - Final state: `Claimed` (2). User gas balance and USDC balance 80.0 → 80.0 (user paid zero fees).
2. **Lock with Intent + Refund Round-Trip:**
   - Lock Tx: `0xae9ffb9190ff9d5528368a6275700ce9ee3800f019b664073e1e8e54fe00d4c5` (block 68965150, gas used: 244,823, duration: 20s, deadline: 1792898096).
   - Refund Tx: `0x72c34137a9187f2e3ca31be1333a3a1f7137333dc901d8cf257c256c355e0ba8` (block 68965203, gas used: 69,073).
   - Lock ID: `0x25cb4ed492405272ffd129f2b668fbbbcaadf7f4c064976bc892156e2a9d6a0c`.
   - Final state: `Refunded` (3). Full 1 USDC returned to user.
