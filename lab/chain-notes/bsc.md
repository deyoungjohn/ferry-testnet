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
