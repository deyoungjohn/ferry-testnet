# Chain notes — base

Per-chain quirks: RPC behaviour, confirmation times, fees, faucets, explorers, mocks used. Append under a dated heading with your agent number.

## 2026-10-22 · L3 EVM contract

- Chain id verified as `84532` via `cast chain-id --rpc-url https://sepolia.base.org`.
- Circle test USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`; deployer, solver and user each hold 20.000000 USDC.
- Deployer `0x8138A3447485aA2613aD07d07123FdD623e48158`, solver `0xC9ec91859Bdb598dC2eeE715934D8231478f7A70`, user `0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd`; all have 0 ETH.
- Canonical CREATE2 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` is present (69 bytes of code).
- Final predicted `FerryHTLC` address for salt `keccak256("ferry-htlc.v1")`: `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`. Predicted from the final artifact with both `forge script` and `cast create2`.
- No Base Sepolia deployment or S-06 round-trip: the deployer and solver have no ETH. The user needs no ETH because the flow is permit + intent relayed by the solver; the solver still needs gas for `lockWithIntent` and `claim`.
- Source verification is not attempted: no BaseScan API key is present in `.env.local`.
