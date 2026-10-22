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
