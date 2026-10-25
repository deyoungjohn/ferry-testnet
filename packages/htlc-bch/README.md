# @ferry/htlc-bch

CashTokens-enabled Hash Time-Locked Contract (HTLC) and transaction builders for Bitcoin Cash (Chipnet / Mainnet).

## Features

- **P2SH32 CashTokens HTLC**: SHA-256 hash lock, CLTV refund locktime, token amount and category introspection, and strict output destination enforcement.
- **Lock / Funding Builder (`buildLockTransaction`)**:
  - Deterministic coin selection via `selectLockInputs`.
  - Exact token change (with 1000 sat dust carry) and BCH change calculation.
  - Sub-dust BCH change absorbed into miner fee (dust limit 546 sats respected).
  - Dual outputs:
    1. **Unsigned Transaction**: includes Libauth `Transaction`, raw `txHex`, `sourceOutputs`, and `wcSignRequest` matching `@wizardconnect/*` / `@bch-wc2/interfaces` specification.
    2. **Signed Transaction**: signed directly with WIF or private key for solver and tests.
- **Spend Builders**:
  - `buildClaimTransaction`: Keyless claim with 32-byte secret preimage.
  - `buildRefundTransaction`: CLTV refund back to user after block deadline.

---

## Lock Builder (`buildLockTransaction`)

### Usage

```typescript
import { buildLockTransaction, selectLockInputs } from '@ferry/htlc-bch';

const result = buildLockTransaction({
  params: {
    hashLock: '0x' + sha256HashHex,
    recipientLockingBytecode: solverP2pkhBytecode,
    refundLockingBytecode: userP2pkhBytecode,
    tokenCategory:
      'ec335fd3ffa45f80cef7217cf98e8adf562df5a3e33f354f69df2951703586ac',
    tokenAmount: 1000n, // e.g. 10.00 tPUSD
    refundHeight: 330000,
    maxFee: 1500n,
  },
  utxos: userFulcrumUtxos, // Raw Fulcrum UTXOs from listunspent(sh, 'include_tokens')
  changeAddress: userCashAddress,
  bchCarrySats: 2000n, // satoshis placed in HTLC output
  tokenChangeCarrySats: 1000n, // satoshis placed in token change (if any)
  wif: userWif, // Optional: if omitted, only unsigned is returned
});
```

### Outputs Structure

1. **Output 0 (HTLC P2SH32)**:
   - Locking bytecode: `deriveHtlcAddresses(params).lockingBytecode`
   - Value: `bchCarrySats` (e.g. 2000 satoshis)
   - Token: `{ category: tokenCategory, amount: tokenAmount }`
2. **Output 1 (Token Change - conditional)**:
   - Created only if selected token inputs exceed `tokenAmount`.
   - Value: `tokenChangeCarrySats` (1000 satoshis).
   - Token: `{ category: tokenCategory, amount: selectedTokenAmount - tokenAmount }`.
3. **Output 2 (BCH Change - conditional)**:
   - Created only if remaining satoshis `>= 546` (dust limit).
   - If remaining satoshis `< 546`, they are absorbed into miner fee to prevent unspendable dust outputs.

---

## Dual Output Specification

### (a) Unsigned Transaction & WizardConnect Format

`result.unsigned.wcSignRequest` implements the `WcSignTransactionRequest` protocol from `@bch-wc2/interfaces` used by `@wizardconnect/*` wallet integrations:

```typescript
export interface WcSourceOutput {
  outpointIndex: number;
  outpointTransactionHash: Uint8Array; // 32-byte outpoint hash
  sequenceNumber: number;
  unlockingBytecode: Uint8Array; // Empty before signing
  valueSatoshis: bigint;
  lockingBytecode: Uint8Array; // P2PKH locking script of the input
  token?: {
    category: Uint8Array; // 32-byte category
    amount: bigint;
  };
}

export interface WcSignTransactionRequest {
  transaction: string; // Raw unsigned tx hex (or Libauth Transaction)
  sourceOutputs: WcSourceOutput[]; // 1:1 with transaction.inputs
  broadcast: boolean; // false (wallet or app broadcasts)
  userPrompt?: string; // Display prompt for the wallet UI
}
```

### (b) Signed Transaction

When `wif` or `privateKey` is provided in `BuildLockTxOptions`:

- `result.signed.txHex`: Fully signed raw transaction hex string.
- `result.signed.txid`: 64-character RPC transaction ID.
- `result.signed.transaction`: Decoded Libauth `Transaction` structure.

---

## Input Selection Helper (`selectLockInputs`)

Given a list of UTXOs (accepts Fulcrum UTXOs from `blockchain.scripthash.listunspent` with `'include_tokens'`, CashScript `Utxo`, or `LockUtxo`):

1. **Safety Filters**:
   - Skips any UTXO carrying an NFT (`token.nft` is defined).
   - Skips any UTXO carrying a different token category.
2. **Token Selection**:
   - Sorts candidate token UTXOs **descending by token amount** (largest UTXO first).
   - Breaks ties deterministically by `txid` ascending, then `vout` ascending.
   - Accumulates until `tokenAmount` is satisfied.
   - Throws clear error if total token balance is insufficient.
3. **BCH Coin Selection**:
   - Computes satoshi deficit: `bchCarrySats + (hasTokenChange ? 1000 : 0) + estimatedFee - tokenSatoshis`.
   - If satoshis are needed, sorts candidate pure BCH UTXOs **ascending by satoshis**.
   - **Smallest sufficient single input**: selects the smallest single pure BCH UTXO that covers the deficit.
   - If no single UTXO covers the deficit, accumulates smallest pure BCH UTXOs ascending until sufficient.
   - Throws clear error if total BCH balance is insufficient.

---

## Verification & Tests

Hermetic test rule: Tests must be hermetic; any artifact required by tests must be compiled as part of the test script or checked in (the sequence `pnpm install` then `pnpm test` without an intermediate build step must always succeed).

Run all unit and consensus VM tests:

```bash
pnpm --filter @ferry/htlc-bch test
pnpm --filter @ferry/htlc-bch typecheck
```
