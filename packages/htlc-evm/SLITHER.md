# Slither triage

- Slither 0.11.6
- solc 0.8.28, Foundry 1.8.3
- Full run: `slither .` — 66 results across the project and its dependencies.
- Contract-only run: `slither . --filter-paths 'node_modules|lib|test|script'` — 5 results, all in `src/FerryHTLC.sol`.

## Contract findings

| Detector               | Location                                               | Disposition                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arbitrary-send-erc20` | `lockWithIntent` pulls `owner`’s tokens                | Accepted. `owner` is the address recovered from the EIP-712 intent or validated by ERC-1271; the intent binds token, recipient, amount, hashLock and deadline, and the contract only moves the amount the owner signed for. |
| `timestamp`            | `intentDeadline`, `deadline`, and `refund` comparisons | Accepted. Timestamp deadlines are the protocol design (§4); the EVM side mirrors BCH’s lower-bound `nLockTime`. Validator drift is covered by the 24 h / 6 h margins in §4.1.                                               |
| `timestamp`            | `_validateLock` deadline check                         | Accepted. Same deadline rule as above.                                                                                                                                                                                      |
| `naming-convention`    | `DOMAIN_SEPARATOR`                                     | Accepted. The name is the EIP-712/EIP-2612 convention and is part of the XV-003 interface.                                                                                                                                  |

## Dependency and tooling findings

The full run also reports the following outside `src/`. None are reachable through a code path introduced by FerryHTLC.

| Detector                  | Where                                                         | Disposition                                                                                                             |
| ------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `incorrect-exp`           | OpenZeppelin `Math.mulDiv`                                    | False positive: the `^` is intentional bitwise XOR in the Newton–Raphson inverse.                                       |
| `divide-before-multiply`  | OpenZeppelin `Math.mulDiv` / `invMod`                         | Intentional algorithm; upstream audited code.                                                                           |
| `unused-return`           | OpenZeppelin `SignatureChecker`                               | The returned error is handled by the library; the detector loses it across the tuple destructuring.                     |
| `assembly`                | OpenZeppelin `SafeERC20`                                      | Required for non-standard ERC-20 return values; upstream audited code.                                                  |
| `pragma` / `solc-version` | OpenZeppelin interfaces and libraries (`^0.8.20`, `>=0.4.16`) | OpenZeppelin supports a range; this project compiles everything with 0.8.28. The deployed contract pins 0.8.28 exactly. |
| `low-level-calls`         | OpenZeppelin `SignatureChecker`                               | ERC-1271 staticcall; upstream code.                                                                                     |
| `too-many-digits`         | OpenZeppelin `Bytes` / `Math`                                 | Constant bit masks and lookup tables; upstream code.                                                                    |

## Forge lint warnings

`forge build` reports `arbitrary-send-erc20` on the owner pull, `block-timestamp` on the deadline checks, and `reentrancy-events` because `Locked` is emitted after the ERC-1271 signature check. They are intentional: `owner` is authenticated by the signed intent, timestamps implement the protocol deadlines, and `nonReentrant` plus checks-effects-interactions keep the event order sound. The forge linter findings are not part of the Slither result.
