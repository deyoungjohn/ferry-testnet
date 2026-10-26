# Chain notes — bsc

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

---

## 2026-10-25 · L6 BSC Testnet Probe & S-12 Decimals

### Public RPC and Block Tags
- Tested RPC endpoints: `https://data-seed-prebsc-1-s1.binance.org:8545` and `https://bsc-testnet-rpc.publicnode.com`.
- Chain ID: 97.
- Block tags: Both `safe` and `finalized` tags succeed on `eth_getBlockByNumber`. At block 138772963, `safe` was 138772963 and `finalized` was 138772962 (~1 block behind, fast Parlia BFT finality).
- Event logs quirk: The default `data-seed-prebsc-1-s1.binance.org` endpoint throttles/rejects `eth_getLogs` with error code `-32005: limit exceeded`. `https://bsc-testnet-rpc.publicnode.com` succeeds over 1,000 block ranges.
- Explorer: `https://testnet.bscscan.com`.

### Token Verification & 18 Decimals Quirk (S-12)
- BSC Mainnet USDT:
  - Address: `0x55d398326f99059fF775485246999027B3197955`.
  - Symbol: `USDT`, Decimals: **18** (Binance-Peg BSC-USD).
  - EIP-2612 Permit: Not supported.
- BSC Testnet USDT:
  - Address: `0x7ef95a0FEE0Dd31b22626fA2e10Ee6A223F8a684` (Binance Testnet USDT).
  - Symbol: `USDT`, Decimals: **18**.
  - EIP-2612 Permit: Not supported (`DOMAIN_SEPARATOR()` reverts).
- 18 Decimals Property Verification:
  - Added property test suite `test/S12BscUsdtProperty.t.sol`.
  - Verified exact amount preservation: locked 25e18 (`25000000000000000000` matching `@ferry/core` `bsc18` fixture) and claimed/refunded with 0 wei loss/truncation.
  - 256 fuzz test runs passing.

### Deployment and Live Test Status
- Target CREATE2 Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`.
- Blocked on Funding: Deployer (`0x8138A3447485aA2613aD07d07123FdD623e48158`) and Solver (`0xC9ec91859Bdb598dC2eeE715934D8231478f7A70`) currently hold 0 tBNB.

---

## 2026-10-26 · BSC Testnet CREATE2 Deployment

### Contract Deployment
- Target & Deployed Address: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641` (exact byte-for-byte code match across Base Sepolia, Ethereum Sepolia, Arc, and Arbitrum Sepolia).
- Canonical CREATE2 Factory: `0x4e59b44847b379578588920cA78FbF26c0B4956C` (confirmed present and verified).
- Deploy Transaction: `0x9df32d95c2275c3c9adf4c785c5a90fdb08438f21fa632758d3f5d5b5ed21e48` (Block 139032942).
- Status: Successfully deployed to canonical address on BSC Testnet.
- Round-Trip Status: Deployer and Solver hold 0.1 tBNB gas. Live round trip awaits testnet USDT minting/funding to `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd` or `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70` on BSC Testnet.


---

## 2026-10-26 · BSC Testnet Live Round-Trip Execution (S-12 PASS)

### On-Chain Token & Contract Parameters
- Official BSC Testnet BEP-20 USDT: `0x337610d27c682E347C9cD60BD4b3b107C9d34dDd` (18 decimals; symbol USDT).
- Deployed `FerryHTLC`: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`.
- Gas funding tx (Deployer -> User, 0.02 tBNB): `0x29eb147e26f6f4f46743fae02388f7cdcd4f66ce735e069b069bbed0aa949a9c`.

### Live Round-Trip Execution
1. **Lock + Claim Round-Trip (1.0 USDT = 10^18 units):**
   - User Approve tx: `0x037219c2e5460edf53e5e466f9bd26b9cbf38657202e53209ef1e0ea00c4a87c` (Block 139064597, gasUsed 46,194)
   - User Lock tx: `0x86698de71940c1c1fdf3a0a7d98cfa26867a8b95f83cbf5a0d81e9659bc714e2` (Block 139064602, gasUsed 198,797)
   - Lock ID: `0x3092e7c3084ff783cffa6d25dfabf02c036cc38cdfc23818ecec0edcb5e66d81`
   - Solver Claim tx: `0x863f584a51a9c68e2a480dd1d590d6ee22edbc14b50123f71cbce9c5b8028d9e` (Block 139064609, gasUsed 68,228)
   - Result: Verified on-chain state transition to `Claimed (2)`; Solver received 1.0 USDT.

2. **Lock + Refund Round-Trip (1.0 USDT = 10^18 units):**
   - User Approve tx: `0xdf67438a4403498548e5ca1ce312d5aa32dbd66f4b5708f982e27c9e6e02748c` (Block 139064616, gasUsed 46,194)
   - User Lock tx: `0x82e32fb2b3682433217b3051e8ace62c130ee5f4b8469b7c298ac1fb365c88b0` (Block 139064621, gasUsed 198,797)
   - Lock ID: `0x8da3921729a7a0898c2010ac5093035e17097156f212d3f63c5ad6a1cb182bcf`
   - User Refund tx: `0x37244958c809a2e403b699c5cdd20b62b2ba75c3bf8a31239064046e9b2b15ab` (Block 139064724, gasUsed 47,790)
   - Result: Verified on-chain state transition to `Refunded (3)` after 45s deadline expiry; User balance restored.
