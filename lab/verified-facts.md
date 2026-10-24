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
