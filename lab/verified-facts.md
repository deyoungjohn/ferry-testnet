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
| FACT-A3-001 · CashScript compiler & SDK | cashc@0.14.0 / cashscript@0.14.0 | npm view cashc@0.14.0 version; npm view cashscript@0.14.0 version | 2026-10-23 | 3 | Pinned in packages/htlc-bch/package.json; uses contract.unlock.<fn>() API |
| FACT-A3-002 · Libauth version | @bitauth/libauth@3.0.0 | npm view @bitauth/libauth@3.0.0 version | 2026-10-23 | 3 | Pinned in packages/htlc-bch/package.json; pure JS BCH VM and address utilities |
| FACT-A3-003 · BCH Script VM consensus | BCH2023 (May 2023 CashTokens / P2SH32) | libauth createVirtualMachineBCH() === createVirtualMachineBCH2023() | 2026-10-23 | 3 | Libauth 3.0.0 default BCH VM implements active Chipnet & Mainnet script rules |
| FACT-A3-004 · Chipnet tPUSD Token Category | ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac | Mint tx c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d | 2026-10-23 | 3 | Display order (RPC); supply 100,000,000.00; 2 decimals; fungible-only |
| FACT-A3-005 · Chipnet tMUSD Token Category | c99627aec3e041f281068704c2609699d234586d5097301eff995f3bd00ac04d | Mint tx 4a540e2f13f28bc1297db79788f3a949c9e6ca823e00bcc4fe922dd2a106961d | 2026-10-23 | 3 | Display order (RPC); supply 100,000,000.00; 2 decimals; fungible-only |
| FACT-A3-006 · Fulcrum listunspent token filter | "include_tokens" parameter | Fulcrum RPC specification & test on wss://chipnet.imaginary.cash:50004 | 2026-10-23 | 3 | Defaults to "exclude_tokens"; must pass "include_tokens" to return CashTokens UTXOs |
