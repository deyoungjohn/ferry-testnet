# Verified facts

Versions, addresses, chain IDs, decimals, endpoints. Never guess: every row needs a source. Append-only; to correct a row, append a new one and mark the old one "superseded by" in its notes.

| Fact | Value | Source | Verified on | Agent | Notes |
|---|---|---|---|---|---|
| FACT-A2-001 · Node runtime | 22.23.1 | node --version; command -v node; ~/.bashrc NVM initialization | 2026-10-22 | 2 | NVM binary at ~/.nvm/versions/node/v22.23.1/bin/node; fnm unnecessary; .nvmrc pinned |
| FACT-A2-002 · pnpm workspace | 9.15.9 | npm view pnpm versions; npm view pnpm@9 version; corepack pnpm --version | 2026-10-22 | 2 | Latest registry 9.x; packageManager pin; D-A2-001 |
| FACT-A2-003 · pnpm outside workspace | 12.8.1 | pnpm --version from /home/user | 2026-10-22 | 2 | Global installation retained; workspace launcher selects 9.15.9 |
| FACT-A2-004 · npm / Corepack | 10.9.8 / 0.34.6 | npm --version; corepack --version | 2026-10-22 | 2 | Installed with active Node environment |
| FACT-A2-005 · Foundry forge / anvil / cast | 1.8.3 / 1.8.3 / 1.8.3 | forge --version; anvil --version; cast --version | 2026-10-22 | 2 | Commit cae51ad458f6abb64852b7709eb784352429825d; not upgraded |
| FACT-A2-006 · Solana CLI / cargo-build-sbf | 4.1.2 / 4.1.0 | solana --version; cargo build-sbf --version | 2026-10-22 | 2 | Agave commit 182084b8; build-sbf default reports platform-tools v1.54; not upgraded |
| FACT-A2-007 · Anchor CLI / AVM | 1.2.1 / 1.2.1 | anchor --version; avm --version | 2026-10-22 | 2 | Existing binaries retained; Anchor probe measured 0.03 s; |
| FACT-A2-008 · TronBox | 4.11.0 | npm view tronbox version; tronbox version | 2026-10-22 | 2 | npm install -g tronbox@4.11.0 uses writable NVM prefix; bundled tron-solc reports 0.8.31 |
| FACT-A2-009 · Slither analyzer | 0.11.6 | pipx install slither-analyzer; pipx list --short; slither --version | 2026-10-22 | 2 | User-level pipx virtual environment; Python 3.12.3 |
| FACT-A2-010 · pipx / jq | 1.4.3 / 1.7 | pipx --version; jq --version | 2026-10-22 | 2 | Apt prerequisites already installed when this task reached them |
| FACT-A2-011 · cargo / rustc | 1.99.1 / 1.99.1 | cargo --version; rustc --version | 2026-10-22 | 2 | Existing toolchain retained; no rustup update |
| FACT-A2-012 · cloudflared | 2026.9.3 | cloudflared --version | 2026-10-22 | 2 | Version check only; no tunnel started |
| FACT-A2-013 · GitHub CLI | 2.45.0 | gh --version | 2026-10-22 | 2 | Existing Ubuntu package |
| FACT-A2-014 · Python | 3.12.3 | python3 --version | 2026-10-22 | 2 | System Python used by pipx |
| FACT-A2-015 · @eslint/js | 10.0.1 | npm view @eslint/js@10.0.1 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-016 · @types/node | 22.20.5 | npm view @types/node@22.20.5 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-017 · eslint | 10.13.0 | npm view eslint@10.13.0 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-018 · prettier | 3.9.10 | npm view prettier@3.9.10 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-019 · typescript | 5.9.3 | npm view typescript@5.9.3 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-020 · typescript-eslint | 8.72.0 | npm view typescript-eslint@8.72.0 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-021 · vitest | 5.0.5 | npm view vitest@5.0.5 version; pnpm install | 2026-10-22 | 2 | Exact direct dependency pin; transitive versions and integrities in pnpm-lock.yaml |
| FACT-A2-022 · npm package-name lookup | @ferry/core: E404; @ferryswap/core: E404 | npm view @ferry/core; npm view @ferryswap/core | 2026-10-22 | 2 | Neither package is published. This does not prove scope ownership or publishing permission. Keep @ferry/core for private workspace use. |
| FACT-A2-023 · Base chain IDs / Sepolia RPC | mainnet 8453; Sepolia 84532; https://sepolia.base.org | https://docs.base.org/get-started/connect-to-base | 2026-10-22 | 2 | Official network table; no transaction sent |
| FACT-A2-024 · Circle USDC contracts | Base 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; Base Sepolia 0x036CbD53842c5426634e7929541eC2318f3dCF7e | https://developers.circle.com/stablecoins/usdc-contract-addresses | 2026-10-22 | 2 | Official mainnet and testnet tables; no on-chain probe |
| FACT-A2-025 · core scaffold version | 0.0.0 | packages/core/package.json; packages/core/test/index.test.ts | 2026-10-22 | 2 | Local private package; smoke test checks VERSION export |
| FACT-A2-026 · Project-selected SBF tools | platform-tools v1.57; rustc 1.95.0-dev (ae660768a 2026-08-17) | avm platform-tools resolve --anchor-version 1.2.1; ~/.cache/solana/v1.57/platform-tools/rust/bin/rustc --version | 2026-10-22 | 2 | Resolves via Solana 4.1.2; already present at first task probe; differs from latest-release reminder |
| FACT-A2-027 · Requested latest SBF cache | platform-tools v1.58; rustc 1.95.0-dev (1e20dd0d5 2026-10-05) | https://api.github.com/repos/anza-xyz/platform-tools/releases/tags/v1.58 ; ~/.cache/solana/v1.58/platform-tools/rust/bin/rustc --version | 2026-10-22 | 2 | Official archive 531406444 bytes; SHA-256 7b82eb420b5aebd1e5590db0ae25c523eca06724d4238ae02139690535636c37 verified before extraction; install-only then succeeds with an actual Rust executable present |
| Node.js (runtime) | 22.23.1 | `node -v` | 2026-10-22 | A1 | Matches root `engines` (`>=22 <23`) |
| pnpm | 12.8.1 | `pnpm -v` | 2026-10-22 | A1 | Workspace toolchain is owned by A2; this is what the L0 web install used |
| react | 19.3.1 | `npm view react version` | 2026-10-22 | A1 | Blueprint §6 asks React 19; major unchanged |
| react-dom | 19.3.1 | `npm view react-dom version` | 2026-10-22 | A1 | |
| react-router | 8.5.0 | `npm view react-router version` | 2026-10-22 | A1 | `react-router-dom` still exists at 7.18.4; v8 keeps the DOM APIs in `react-router` |
| vite | 8.3.5 | `npm view vite version` | 2026-10-22 | A1 | Blueprint says Vite 6; current stable major chosen (D-A1-001) |
| @vitejs/plugin-react | 6.1.2 | `npm view @vitejs/plugin-react version` | 2026-10-22 | A1 | Peer requires Vite 8 |
| tailwindcss | 4.3.3 | `npm view tailwindcss version` | 2026-10-22 | A1 | Blueprint §6 asks Tailwind 4 |
| @tailwindcss/vite | 4.3.3 | `npm view @tailwindcss/vite version` | 2026-10-22 | A1 | |
| typescript | 5.9.3 | `npm view typescript@5 version` | 2026-10-22 | A1 | Latest is 7.0.2, but typescript-eslint 8.72.0 peers `>=4.8.4 <6.1.0` (D-A1-001) |
| vitest | 5.0.5 | `npm view vitest version` | 2026-10-22 | A1 | Peer supports Vite 8; Node >=22.12 |
| jsdom | 30.1.3 | `npm view jsdom version` | 2026-10-22 | A1 | |
| @testing-library/react | 16.3.3 | `npm view @testing-library/react version` | 2026-10-22 | A1 | |
| @testing-library/dom | 10.4.2 | `npm view @testing-library/dom version` | 2026-10-22 | A1 | Explicit peer of Testing Library React 16 |
| @testing-library/jest-dom | 7.0.1 | `npm view @testing-library/jest-dom version` | 2026-10-22 | A1 | |
| @playwright/test | 1.64.1 | `npm view @playwright/test version` | 2026-10-22 | A1 | Expects Chromium revision 1248 |
| Playwright Chromium | 1248 | Playwright launch error + `~/.cache/ms-playwright/chromium-1248` | 2026-10-22 | A1 | Pre-existing cache had 1247 from another install |
| eslint | 10.13.0 | `npm view eslint version` | 2026-10-22 | A1 | |
| @eslint/js | 10.0.1 | `npm view @eslint/js version` | 2026-10-22 | A1 | |
| typescript-eslint | 8.72.0 | `npm view typescript-eslint version` | 2026-10-22 | A1 | Peer TypeScript `<6.1.0` |
| eslint-plugin-react-hooks | 7.1.1 | `npm view eslint-plugin-react-hooks version` | 2026-10-22 | A1 | |
| eslint-plugin-react-refresh | 0.5.7 | `npm view eslint-plugin-react-refresh version` | 2026-10-22 | A1 | |
| globals | 17.13.0 | `npm view globals version` | 2026-10-22 | A1 | |
| @types/react | 19.3.0 | `npm view @types/react version` | 2026-10-22 | A1 | |
| @types/react-dom | 19.3.0 | `npm view @types/react-dom version` | 2026-10-22 | A1 | |
| @types/node | 22.20.5 | `npm view @types/node@22 version` | 2026-10-22 | A1 | Matches Node 22 runtime |
| @fontsource-variable/inter | 5.3.0 | `npm view @fontsource-variable/inter version` | 2026-10-22 | A1 | Self-hosted; Fontsource has no Inter Display package |
| @fontsource/instrument-serif | 5.3.0 | `npm view @fontsource/instrument-serif version` | 2026-10-22 | A1 | Latin 400 italic subset imported |
| FACT-A3-001 · tsx version | 4.23.15 | npm view tsx version | 2026-10-22 | 3 | Workspace script execution |
| FACT-A3-002 · vitest version | 5.0.5 | npm view vitest version | 2026-10-22 | 3 | Test runner |
| FACT-A3-003 · typescript version | 7.0.2 | npm view typescript version | 2026-10-22 | 3 | Superseded by FACT-A3-015 (pinned to 5.9.3) |
| FACT-A3-004 · @types/node version | 26.6.5 | npm view @types/node version | 2026-10-22 | 3 | Superseded by FACT-A3-016 (pinned to 22.20.5) |
| FACT-A3-005 · viem version | 2.57.10 | npm view viem version | 2026-10-22 | 3 | EVM client |
| FACT-A3-006 · @bitauth/libauth version | 3.0.0 | npm view @bitauth/libauth version | 2026-10-22 | 3 | BCH primitives & address encoding |
| FACT-A3-007 · @electrum-cash/network version | 4.4.8 | npm view @electrum-cash/network version | 2026-10-22 | 3 | Recorded, not yet used (scripts uses ws directly) |
| FACT-A3-008 · ws version | 8.22.0 | npm view ws version | 2026-10-22 | 3 | WebSocket client for Fulcrum |
| FACT-A3-009 · @types/ws version | 8.18.2 | npm view @types/ws version | 2026-10-22 | 3 | WebSocket typings |
| FACT-A3-010 · BCH Chipnet Fulcrum URL | wss://chipnet.imaginary.cash:50004 | docs/Ferry_Engineering_Blueprint.md §7.5 & live query | 2026-10-22 | 3 | Returns Fulcrum 2.1.4, protocol 1.4, tip ~329042 |
| FACT-A3-011 · Base Sepolia RPC URL | https://sepolia.base.org | Base official docs & live query | 2026-10-22 | 3 | Chain ID 84532; supports safe, finalized tags, and eth_getLogs |
| FACT-A3-012 · Base Sepolia Circle USDC address | 0x036CbD53842c5426634e7929541eC2318f3dCF7e | Circle Developer Docs & on-chain query | 2026-10-22 | 3 | name='USDC', symbol='USDC', decimals=6, version='2', DOMAIN_SEPARATOR=0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818 |
| FACT-A3-013 · BCH Chipnet Faucet | https://tbch.googol.cash/ | Community faucet & live form check | 2026-10-22 | 3 | Chipnet network radio; simple math captcha |
| FACT-A3-014 · Base Sepolia USDC Faucet | https://faucet.circle.com/ | Circle Developer Portal | 2026-10-22 | 3 | Dispenses 10 USDC on Base Sepolia, 2h cooldown |
| FACT-A3-015 · typescript workspace alignment | 5.9.3 | npm view typescript@5.9.3 version; package.json | 2026-10-23 | 3 | Supersedes FACT-A3-003; aligns with root workspace and typescript-eslint (D-A1-001) |
| FACT-A3-016 · @types/node runtime alignment | 22.20.5 | npm view @types/node@22.20.5 version; package.json | 2026-10-23 | 3 | Supersedes FACT-A3-004; matches Node 22 LTS runtime |
| FACT-A2-028 · viem | 2.57.10 | npm view viem version; pnpm install | 2026-10-22 | A2 | Exact dependency pin; coverage provider matches Vitest |
| FACT-A2-029 · zod | 4.6.7 | npm view zod version; pnpm install | 2026-10-22 | A2 | Exact dependency pin; coverage provider matches Vitest |
| FACT-A2-030 · fast-check | 4.10.2 | npm view fast-check version; pnpm install | 2026-10-22 | A2 | Exact dependency pin; coverage provider matches Vitest |
| FACT-A2-031 · cborg | 6.1.4 | npm view cborg version; pnpm install | 2026-10-22 | A2 | Exact dependency pin; coverage provider matches Vitest |
| FACT-A2-032 · @vitest/coverage-v8 | 5.0.5 | npm view @vitest/coverage-v8@5.0.5 version; pnpm install | 2026-10-22 | A2 | Exact dependency pin; coverage provider matches Vitest |
| FACT-A2-033 · BSC fixture network ID | 97 (BSC testnet) | https://docs.bnbchain.org/bnb-smart-chain/developers/wallet-configuration/ | 2026-10-22 | A2 | Synthetic HTLC/token/user addresses in the golden fixture are test data, not deployments |
| FACT-A2-034 · Personal-sign representation | viem raw attribute signs data bytes; string input signs UTF-8 | https://viem.sh/docs/accounts/local/signMessage | 2026-10-22 | A2 | Raw order-id signature passes; text signature rejected by the same verifier |
| FACT-A1-006 · OpenZeppelin Contracts | 5.6.1 | npm view @openzeppelin/contracts version (latest dist-tag 5.6.1; 5.7.0 is dev) | 2026-10-22 | 1 | Exact npm release; integrity in pnpm-lock.yaml; D-A1-005 |
| FACT-A1-007 · forge-std | v1.9.7 (commit 77041d2ce690e692d6e03cc812b57d1ddaa4d505) | git ls-remote https://github.com/foundry-rs/forge-std.git refs/tags/v1.9.7; pnpm lockfile resolution | 2026-10-22 | 1 | Installed as a GitHub tag tarball into node_modules, not a submodule; keeps the shared repo free of .gitmodules |
| FACT-A1-008 · solc | 0.8.28 | foundry.toml solc_version; forge build output "Compiling … with Solc 0.8.28" | 2026-10-22 | 1 | Exact pragma in FerryHTLC.sol; downloaded by Foundry |
| FACT-A1-009 · canonical CREATE2 factory | 0x4e59b44847b379578588920cA78FbF26c0B4956C | https://github.com/Arachnid/deterministic-deployment-proxy; cast codesize on Base Sepolia returned 69 | 2026-10-22 | 1 | Deployed on Base Sepolia; called with bytes32 salt followed by init code |
| FACT-A1-010 · FerryHTLC predicted address | 0x5A0C062f4B7b8fF2263530e12bc15De9C836a641 | forge script script/Deploy.s.sol:Deploy on Base Sepolia + cast create2 with salt keccak256("ferry-htlc.v1") and final artifact | 2026-10-22 | 1 | Predicted only; deployer has 0 Base Sepolia ETH. Recompute after any contract change |
| FACT-A1-011 · Base Sepolia role addresses and balances | deployer 0x8138A3447485aA2613aD07d07123FdD623e48158 (0 ETH); solver 0xC9ec91859Bdb598dC2eeE715934D8231478f7A70 (0 ETH); user 0x87Ea46fe296C1810eF234A8e8D782A2122deFaDd (0 ETH) | cast wallet address --private-key; cast balance --rpc-url https://sepolia.base.org | 2026-10-22 | 1 | Keys stayed in .env.local; no private key printed |
| FACT-A1-012 · Circle test USDC balances | 20.000000 USDC each for deployer, solver and user on Base Sepolia | cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "balanceOf(address)(uint256)" | 2026-10-22 | 1 | 20,000,000 base units at 6 decimals; token address matches FACT-A2-024 |
| FACT-A3-001 · CashScript compiler & SDK | cashc@0.14.0 / cashscript@0.14.0 | npm view cashc@0.14.0 version; npm view cashscript@0.14.0 version | 2026-10-23 | 3 | Pinned in packages/htlc-bch/package.json; uses contract.unlock.<fn>() API |
| FACT-A3-002 · Libauth version | @bitauth/libauth@3.0.0 | npm view @bitauth/libauth@3.0.0 version | 2026-10-23 | 3 | Pinned in packages/htlc-bch/package.json; pure JS BCH VM and address utilities |
| FACT-A3-003 · BCH Script VM consensus | BCH2023 (May 2023 CashTokens / P2SH32) | libauth createVirtualMachineBCH() === createVirtualMachineBCH2023() | 2026-10-23 | 3 | Libauth 3.0.0 default BCH VM implements active Chipnet & Mainnet script rules |
| FACT-A3-004 · Chipnet tPUSD Token Category | ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac | Mint tx c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d | 2026-10-23 | 3 | Display order (RPC); supply 100,000,000.00; 2 decimals; fungible-only |
| FACT-A3-005 · Chipnet tMUSD Token Category | c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d | Mint tx 4a540e2f13f28bc1297db79788f3a949c9e6ca823e00bcc4fe922dd2a106961d | 2026-10-23 | 3 | Display order (RPC); supply 100,000,000.00; 2 decimals; fungible-only |
| FACT-A3-006 · Fulcrum listunspent token filter | "include_tokens" parameter | Fulcrum RPC specification & test on wss://chipnet.imaginary.cash:50004 | 2026-10-23 | 3 | Defaults to "exclude_tokens"; must pass "include_tokens" to return CashTokens UTXOs |
| FACT-A1-013 · FerryHTLC deployment | 0x5A0C062f4B7b8fF2263530e12bc15De9C836a641, 3361 bytes; tx 0xa47e4d4610f2f6c3021226e8ecef3cc54d1816afdf4fb151f2134c321694e958 | cast code; cast receipt on Base Sepolia | 2026-10-24 | 1 | Matches FACT-A1-010 prediction; supersedes the "predicted only" note |
| FACT-A1-014 · Base Sepolia balances after L3 | deployer 0.099995172741984282 ETH / 20 USDC; solver 0.099998079177997704 ETH / 20 USDC; user 0.1 ETH / 40 USDC | cast balance; cast call balanceOf | 2026-10-24 | 1 | Supersedes FACT-A1-011/012; balances observed after the round-trip, source of the user USDC increase not recorded here |
| FACT-A1-015 · Circle USDC EIP-712 domain | name "USDC"; version "2"; domain separator 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818; 6 decimals | cast call name(), version(), DOMAIN_SEPARATOR(), decimals() on Base Sepolia USDC | 2026-10-24 | 1 | Used by the headless S-06 permit signature; address 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
| FACT-A3-017 · XO packages pinned | @xo-cash/engine@0.1.0-next.17437760444, @xo-cash/templates@0.0.11, @xo-cash/utils@0.0.10, @xo-cash/state@0.0.5, @xo-cash/primitives@0.0.3 | npm view <pkg> dist-tags / versions | 2026-10-24 | 3 | Pinned in packages/htlc-bch/package.json; official GitLab GP registry |
| FACT-A3-018 · xo-web-devtool git commit | f937e7fcd2c4954b97f7cccea067caf42bcec4a1 | git clone https://gitlab.com/GeneralProtocols/xo/web-devtool.git; git rev-parse HEAD | 2026-10-24 | 3 | development branch tip cloned into /tmp/xo-scratch/xo-web-devtool |
| FACT-A3-019 · Fulcrum Chipnet endpoint & version | Fulcrum 2.1.4 on wss://chipnet.imaginary.cash:50004 | server.version live query | 2026-10-24 | 3 | Protocol 1.4-1.6; reports cashtokens: true, dsproof: true; Genesis 000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b |
| FACT-A3-020 · Fulcrum Mainnet endpoints & versions | Fulcrum 2.1.4 on wss://bch.imaginary.cash:50004; Fulcrum 2.1.2 on wss://fulcrum.greyh.at:50004 | server.version live query (READ-ONLY) | 2026-10-24 | 3 | Protocol 1.4-1.6; reports cashtokens: true, dsproof: true; Genesis 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f |
| FACT-A3-021 · Fulcrum DSProof methods | blockchain.transaction.dsproof.subscribe([txid]) and blockchain.transaction.dsproof.get([txid]) | live RPC queries on Fulcrum 2.1.2 & 2.1.4 | 2026-10-24 | 3 | Takes single 32-byte tx hash parameter; returns null if uncontested or proof object if double-spent |
| FACT-A3-022 · Chipnet self-spend notification latency | min 804.0 ms, median 1021.1 ms, max 1372.1 ms | 10 sequential self-spends on wss://chipnet.imaginary.cash:50004 | 2026-10-24 | 3 | Broadcast-to-scripthash.subscribe latency; passes < 2000 ms target (D-A3-003) |
| FACT-A3-023 · @electrum-cash/servers version | 4.2.0 | npm view @electrum-cash/servers version | 2026-10-24 | 3 | Pinned in packages/htlc-bch/package.json for Chipnet & Mainnet server presets |
| FACT-A3-024 · S-05 Chipnet probe block height | 329336 (hex: 000000201164c86c...) | blockchain.headers.subscribe on wss://chipnet.imaginary.cash:50004 | 2026-10-24 | 3 | Recorded during S-05 latency probe run |
| FACT-A3-025 · S-05 Mainnet probe block height | 974345 (hex: 00c01d22f1594b...) | blockchain.headers.subscribe on wss://bch.imaginary.cash:50004 (READ-ONLY) | 2026-10-24 | 3 | Recorded during S-05 server feature check |
