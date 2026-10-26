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


---

## 2026-10-30 · Live Testnet Swaps On-Chain Evidence (E2E-01, E2E-03, E2E-04, E2E-03-safe)

All transactions verified on-chain via Base Sepolia RPC (`https://sepolia.base.org`) and BaseScan explorer (`https://sepolia.basescan.org/tx/<txid>`). Contract deployed at `0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`.

### E2E-01 Forward Swap (USDC → tPUSD, Safe Lane, 2026-10-25)
- **User EVM Lock (`lockWithIntent`):**
  - TXID: `0xda6ce785affe7116c6e14442a0debf0d54d078491d9d430968b66884bbb929bc`
  - Block: `49818446`, Gas used: `212455`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0xda6ce785affe7116c6e14442a0debf0d54d078491d9d430968b66884bbb929bc`
- **Solver EVM Claim (`claim`):**
  - TXID: `0x605e9866639e7dceb290037967969aeb3aa2844d6819d9e6474cbce5dbfd076c`
  - Block: `49818483`, Gas used: `61708`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x605e9866639e7dceb290037967969aeb3aa2844d6819d9e6474cbce5dbfd076c`

### E2E-03 Reverse Swap (tPUSD → USDC, Fast Lane, Wallet-Signed Lock, 2026-10-25)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0x3cb821834f7d301646f8dfe96c1a87418382b629100f51a4b24e6853fe1b03f7`
  - Block: `50105734`, Gas used: `198321`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x3cb821834f7d301646f8dfe96c1a87418382b629100f51a4b24e6853fe1b03f7`
- **User EVM Claim (`claim` via `POST /v1/orders/:id/relay-claim`):**
  - TXID: `0x6324d9b1131d242fe59e0da638abc97365c8a77723085d872eb635c20c5c49f0`
  - Block: `50105754`, Gas used: `61708`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x6324d9b1131d242fe59e0da638abc97365c8a77723085d872eb635c20c5c49f0`

### E2E-04 Reverse Swap (tPUSD → USDC, Fast Lane, Manual Send, 2026-10-25)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0xf8c4d651013900c6189c187c9587dc8fd467b6e468ad193bfafa7f2e3d7de18d`
  - Block: `50105818`, Gas used: `198321`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0xf8c4d651013900c6189c187c9587dc8fd467b6e468ad193bfafa7f2e3d7de18d`
- **User EVM Claim (`claim` via `POST /v1/orders/:id/relay-claim`):**
  - TXID: `0xb15635d997da60fa087a0ae1fbbcfe5049e43c3d0329da9e747f1f36411086b8`
  - Block: `50105833`, Gas used: `61708`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0xb15635d997da60fa087a0ae1fbbcfe5049e43c3d0329da9e747f1f36411086b8`

### E2E-03-safe Reverse Swap (tPUSD → USDC, Safe Lane with 1 Block Confirmation, 2026-10-25)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0xf0e7f68decd5ebd05f1e43337e60eb2f66bf8379d211bcd3ec1df626e2082591`
  - Block: `50156437`, Gas used: `198321`, Status: `1 (success)`
  - Confirmation Policy: Broadcast only after user BCH lock reached 1 block confirmation on Chipnet (block `329463`).
  - Explorer: `https://sepolia.basescan.org/tx/0xf0e7f68decd5ebd05f1e43337e60eb2f66bf8379d211bcd3ec1df626e2082591`
- **User EVM Claim (`claim` via `POST /v1/orders/:id/relay-claim`):**
  - TXID: `0x34428991c723d086d9465044453ed28cc5cbb39fe77f7a86412a32722c04f1d4`
  - Block: `50156455`, Gas used: `61708`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x34428991c723d086d9465044453ed28cc5cbb39fe77f7a86412a32722c04f1d4`

---

## 2026-10-26 · Live Swaps On-Chain Evidence against localhost:8787 solver

Executed end-to-end against live solver daemon running on `localhost:8787` (`pnpm dev:solver`) with funded human wallets.

### Forward Swap (USDC → tPUSD, Safe Lane, Order `0x843bae146bbac9ed29ff3299b2f84e3615dc75b599c02060aa7d272d5b6f16ea`)
- **User EVM Lock (`lock`):**
  - TXID: `0x7448e549572da850d61dcebf16b9101d2b47a1935fe1992c0c7e70ae3bae3a63`
  - Block: `50576610`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x7448e549572da850d61dcebf16b9101d2b47a1935fe1992c0c7e70ae3bae3a63`
- **Solver EVM Claim (`claim`):**
  - TXID: `0x67430aae2eab59b994f054b08130201015cbebeb31e57877e63845dec27a49de`
  - Block: `50576625`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x67430aae2eab59b994f054b08130201015cbebeb31e57877e63845dec27a49de`

### Reverse Swap (tPUSD → USDC, Order `0xa71a3bf75579046c8ae3d93c81a3c92fd836eea3b695bf9dc0958b107d46d9ab`)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0x2a9d44370db0e64b1dc1cc4a15c0191af12b5e51561bf790864f97b5c6be90f0`
  - Block: `50577253`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0x2a9d44370db0e64b1dc1cc4a15c0191af12b5e51561bf790864f97b5c6be90f0`
- **User EVM Claim (`claim` via `POST /v1/orders/:id/relay-claim`):**
  - TXID: `0xc01aab351a1257a01c304ae6a1f6c0a851d1bdeaac75e7cdb72180706f6a7e5d`
  - Block: `50577265`, Status: `1 (success)`
  - Explorer: `https://sepolia.basescan.org/tx/0xc01aab351a1257a01c304ae6a1f6c0a851d1bdeaac75e7cdb72180706f6a7e5d`
