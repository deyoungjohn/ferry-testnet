# Cross-check vectors (XV)

When two agents implement the same rule in different languages, each one computes these vectors **independently** and pastes the outputs into their PR under *Checks run*. The maintainers compares them before merging. Agents must not copy each other's outputs.

All hex is lowercase, `0x`-prefixed. All addresses are given in checksum-free lowercase; implementations may checksum them.

---

## XV-001 · Secret and hash lock

| Input | Value |
|---|---|
| `secret` | 32 bytes, every byte `0x01` |

Output: `hashLock = sha256(secret)`.

Implemented by: the EVM package (Solidity/Foundry, `sha256(abi.encodePacked(secret))`), the core package (`@ferry/core`), the BCH package (`@ferry/htlc-bch`, libauth sha256 and a VM evaluation of the claim branch).

## XV-002 · EVM lock id

| Input | Value |
|---|---|
| `sender` | `0x3333333333333333333333333333333333333333` |
| `hashLock` | output of XV-001 |

Output: `lockId = keccak256(abi.encode(sender, hashLock))`.

Implemented by: the EVM package (contract `lockId()`), the core package (`@ferry/core`).

## XV-003 · EIP-712 LockIntent digest

Domain:

| Field | Value |
|---|---|
| name | `FerryHTLC` |
| version | `1` |
| chainId | `84532` (Base Sepolia) |
| verifyingContract | `0x1111111111111111111111111111111111111111` |

Message, type `LockIntent(address token,address recipient,uint256 amount,bytes32 hashLock,uint64 deadline,uint256 intentDeadline)`:

| Field | Value |
|---|---|
| token | `0x036cbd53842c5426634e7929541ec2318f3dcf7e` |
| recipient | `0x2222222222222222222222222222222222222222` |
| amount | `25000000` (25 USDC, 6 decimals) |
| hashLock | output of XV-001 |
| deadline | `1800000000` |
| intentDeadline | `1799990000` |

Outputs: the `LOCK_INTENT_TYPEHASH`, the domain separator, and the final `\x19\x01` digest.

Implemented by: the EVM package (contract, via a Foundry test that deploys/etches at the fixed address on chain id 84532), the core package (`@ferry/core` typed-data definition, via viem `hashTypedData`).

## XV-004 · Token category byte order

| Input | Value |
|---|---|
| category, display (RPC) order | `2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544` (PUSD mainnet, blueprint §7.5; used only as test data) |

Output: the internal (introspection) byte order.

Implemented by: the core package (`@ferry/core` helper, if core keeps one), the BCH package (`@ferry/htlc-bch`).
