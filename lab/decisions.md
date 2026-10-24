# Decisions

Lightweight decision records (template below). Spike answers (S-01…S-14, Q-A…Q-C) go here as pass/fail plus the consequence for the rebuild. IDs: `D-A<n>-<nnn>` (agents), `D-OR-<nnn>` (maintainer). Append-only.

---

### Branch-per-task worktrees, merge commits, merges by the maintainer
- **Evidence:** Three agents work in parallel in the same phase; history doubles as the timing record.
- **Consequence for rebuild:** Use `ph<n>-<slug>` branches in sibling worktrees; merge PRs with merge commits (not squash) so per-commit timings survive.
- **Revisit if:** Review becomes the bottleneck (then consider a 4th agent or batching PRs).

### D-A2-001 · Pin pnpm 9 through packageManager → PASS
- **Evidence:** `npm view pnpm versions` and `npm view pnpm@9 version` confirm 9.15.9 as the latest 9.x release; both `corepack pnpm --version` and the existing pnpm launcher return 9.15.9 inside this workspace. Outside it the installed pnpm remains 12.8.1. A temporary clean clone passes install, build, typecheck, lint and tests with the v9 lockfile.
- **Consequence for rebuild:** Keep the blueprint's major and pin `pnpm@9.15.9` in `packageManager`; use Corepack when the shell launcher does not honor that field. Enable exact saves and engine checks in `.npmrc`. Node is already managed by NVM, so pin its installed 22.23.1 in `.nvmrc` and avoid installing a second version manager.
- **Revisit if:** A future dependency demonstrably requires a newer pnpm major, or the frozen hackathon toolchain is deliberately reverified.

### Package boundaries for chain-specific code, plus cross-agent test vectors
- **Evidence:** Blueprint §5.5 puts BCH script helpers and EVM helpers inside `@ferry/core`, but in the lab three agents build core, the BCH contract and the EVM contract in parallel. Shared ownership of `core/bch` and `core/evm` would serialise them.
- **Consequence for rebuild:** `@ferry/core` holds chain-agnostic protocol logic only: order terms, canonical encoding, `orderId`, signing, pricing, timing, reveal policy, the `ChainAdapter` interface, plus the EIP-712 `LockIntent` typed-data definition and EVM `lockId` derivation (needed by both web and solver). Script-specific code lives with its contract: `@ferry/htlc-bch` (artifact, parameter encoding, P2SH32 derivation, spend builders, category byte order) and `@ferry/htlc-evm` (ABI export, deploy scripts). Where two agents implement the same rule in two languages, both compute a shared cross-check vector (`XV-nnn`, defined in the prompts); the maintainers compares the results before merging.
- **Revisit if:** In the hackathon a single person owns core and both contracts; then the §5.5 layout is fine.
### D-A1-001 · 2026-10-22 · L0 web stack versions
- **Decision:** React 19.3.1, Vite 8.3.5, Tailwind 4.3.3, TypeScript 5.9.3, React Router 8.5.0, Vitest 5.0.5, @playwright/test 1.64.1. Exact pins in `packages/web/package.json`.
- **Evidence:** `npm view <pkg> version` on 2026-10-22 (rows in `verified-facts.md`). Blueprint §6 targets React 19 · Vite 6 · Tailwind 4. React and Tailwind majors still match. Vite 6 is two majors behind current stable; no incompatibility with the chosen React plugin appeared. TypeScript `latest` is 7.0.2, but typescript-eslint 8.72.0 declares support for `<6.1.0`, so 5.9.3 is the newest lint-compatible release (blueprint also says TS 5.x). Fontsource no longer publishes Inter Display, so Inter Variable is self-hosted; Instrument Serif is self-hosted as a latin-only italic subset.
- **Consequence for rebuild:** Resolve Vite to current stable instead of copying the blueprint number, but pin TypeScript to the newest version the lint stack supports rather than `latest`. Check `@playwright/test`'s required Chromium revision before the first e2e run.
- **Revisit if:** typescript-eslint supports TypeScript 7, a Vite 8 plugin breaks, or a design review rejects the Inter Variable look.
