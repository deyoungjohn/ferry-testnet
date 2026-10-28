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

---

## 2026-10-27 · Live Swaps Evidence: Reverse Path Proof (Fast & Safe Lanes,)

Executed end-to-end against live solver daemon running on `localhost:8787` (`pnpm dev:solver`) with testnet keys from root `.env.local`.

### 1. Fast Lane Reverse Swap (0-conf Opt-In, Gasless Relay Claim, Order `0x255b822037ea39e01b3da225f13f2880e7d9b42845e7b5d0f023f469ae8cb5a8`)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0xdca25eea088f0eeeda34081aeb30fcb59f1c01cb4e1bda2a1bedefd5ba938e9b`
  - Block: `50854136`, Status: `1 (success)`, Latency: `11.26s`
  - Confirmation Policy: Broadcast immediately upon detecting user BCH lock in mempool (0-conf under $25 limit with `fastOptIn: true`).
  - Explorer: `https://sepolia.basescan.org/tx/0xdca25eea088f0eeeda34081aeb30fcb59f1c01cb4e1bda2a1bedefd5ba938e9b`
- **User EVM Claim (`claim` via `POST /v1/orders/:id/relay-claim`):**
  - TXID: `0x51b12f1e45ce4e9fb2e11b1bea7df5e33db46c75f62795933bb34ef3464f94e7`
  - Block: `50854150`, Status: `1 (success)`, Latency: `2.89s`
  - Relay: Gas paid by solver relayer; user needed 0 ETH on Base.
  - Explorer: `https://sepolia.basescan.org/tx/0x51b12f1e45ce4e9fb2e11b1bea7df5e33db46c75f62795933bb34ef3464f94e7`

### 2. Safe Lane Reverse Swap (1-Conf BCH, Direct Contract Claim, Order `0x947d75bd270d4488eb0812eab8d5bb7d63d96b2d31afef5ec95215f25d79744d`)
- **Solver EVM Counter-Lock (`lock`):**
  - TXID: `0xcc8cc8489f1f1ec3feef232f19a9e8f89a59ee3e23d252be8cfe42e45061d177`
  - Block: `50857452`, Status: `1 (success)`, Latency: `634.02s`
  - Confirmation Policy: Broadcast only after user BCH lock reached 1 block confirmation on Chipnet (block `329694`).
  - Explorer: `https://sepolia.basescan.org/tx/0xcc8cc8489f1f1ec3feef232f19a9e8f89a59ee3e23d252be8cfe42e45061d177`
- **User EVM Claim (`claim` via direct contract call by user wallet client):**
  - TXID: `0xd1f8ab18224c6c6afc020447fb200ed6eb938b4a0a3ccee932ec041c67d25854`
  - Block: `50858486`, Status: `1 (success)`, Latency: `3.12s`
  - Direct execution: User wallet directly submitted transaction to Base Sepolia HTLC (`0x5A0C062f4B7b8fF2263530e12bc15De9C836a641`) calling `claim(lockId, secret)`.
  - Explorer: `https://sepolia.basescan.org/tx/0xd1f8ab18224c6c6afc020447fb200ed6eb938b4a0a3ccee932ec041c67d25854`

## 2026-10-27 · Live reverse UI proof (script signer)

Order `0xe8878b7edfeff55bfae73838666bec4f47f26688c08fb5ba492833cd2fa7a462`, fast lane, tPUSD → USDC, against a local solver on `127.0.0.1:8787`. The browser used the real reverse quote, `relay-format`, `buildReverseLock`, and the real status page; the test runner held `USER_BCH_WIF` and only returned signed bytes to the page.

- **Solver EVM counter-lock:** `0xf5867b2e003208fa4b1a6b01253e1fef45ddfb2c6a02fd436f8ff23d89fc3369`
  - Explorer: `https://sepolia.basescan.org/tx/0xf5867b2e003208fa4b1a6b01253e1fef45ddfb2c6a02fd436f8ff23d89fc3369`
- **User EVM claim (gasless relay):** `0x75dce99e07ea0b89f9ba256fc81f62d048dd4e5d3396c556d21213250ea21e5a`
  - Explorer: `https://sepolia.basescan.org/tx/0x75dce99e07ea0b89f9ba256fc81f62d048dd4e5d3396c556d21213250ea21e5a`
- **Timings:** quote + BCH lock broadcast 3.807 s; BCH lock to gasless claim available 16.068 s; claim click to `DONE` 6.037 s; total 25.912 s.

## 2026-10-27 · live walkthrough: both directions, both lanes

All four live UI walks ended `DONE` against the isolated solver on `127.0.0.1:8790`; browser key material stayed in the test runner.

| Direction | Lane | Order | Base user lock | Base solver/claim |
|---|---|---|---|---|
| Forward | Fast | `0x036c563702004fc0de2dc46182a319d8617e2a2ef6e4933d412f7bb71b785d19` | `0x1beb1caa3b1b8c0a7fd926dc3a99f5510d38f72f9994003ca0fa60d9c0f28c69` | solver claim `0x4c7b70557e602fe749d7cd99472caac7bb85b42572cb34330717d89c8ff5e030` |
| Forward | Safe | `0xcc9948379ba7a4e1be2647c682034481c675e8974847bb286ff22e4031a1769d` | `0xe30de054cf93c7a4a523ed3caf800a24bcc011e9482ba08df318a869c8737c36` | solver claim `0x35305e5a9a1b804032dac20f383eef5060af76c95b63847a32c7e42c2691b34e` |
| Reverse | Fast | `0xb2bce4bd321cc7f5ed89cb9237f3d0851a8e9c397c26b246f82daef3865d4bea` | — (solver lock) | solver lock `0xc934fafd95b94c50281ee4c118b986387d4357393398e1609a121da89f9c1494`; user claim `0x35d6fd3fd82a091b359c3c762d16437d416ebc7bdc79d55153a0151a06b1762b` |
| Reverse | Safe | `0x71240d04eb8389b1be6ee2187263d7109661c1a96fd9b1dd37b9e989ba248fba` | — (solver lock) | solver lock `0xec4ca08bcb572282669612d48a3b7f3aca986522eabae51c29a04e26b9740df6`; user claim `0xf270cf631b9beed96c2c33bce61ffe77650dd34f114281be7142d09b0dc90a3d` |
- All Base links resolve under `https://sepolia.basescan.org/tx/<txid>`.

---

## 2026-10-28 · Base Mainnet Live Read-Only Verification

- Endpoint tested: `https://mainnet.base.org` over HTTPS JSON-RPC.
- `eth_chainId`: Verified returns `0x2105` (chain ID `8453`).
- Circle USDC on Base Mainnet (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`): `eth_getCode` returns active deployed bytecode (length > 10 bytes).
- Solver startup self-check (`runStartupSelfCheck`) with throwaway key connects, verifies chain ID 8453 and USDC bytecode, and halts cleanly on empty inventory with zero transactions and zero real funds.
- Test coverage: `packages/solver/test/mainnet-refusals.test.ts` opt-in via `FERRY_LIVE_TESTS=1` (with 20s transport timeout and 30s test timeout). Default test suite skips with an informative message to guarantee 100% offline runs.

