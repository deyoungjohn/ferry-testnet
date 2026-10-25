// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title FerryHTLC (Tron Port)
 * @notice Port of Ferry HTLC for TRON TVM.
 * Dropped lockWithIntent (per D-A3-006) as TRC-20 tokens (e.g. USDT) lack EIP-2612 permit;
 * standard approve + lock is used instead.
 * Uses SafeERC20 to natively handle non-standard return values (e.g. USDT returning void).
 */
contract FerryHTLC is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Locked,
        Claimed,
        Refunded
    }

    struct Lock {
        address token;
        address sender;
        address recipient;
        uint256 amount;
        bytes32 hashLock;
        uint64 deadline;
        State state;
    }

    mapping(bytes32 => Lock) public locks;

    event Locked(
        bytes32 indexed id,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    );
    event Claimed(bytes32 indexed id, bytes32 secret);
    event Refunded(bytes32 indexed id);

    error AlreadyExists();
    error NotLocked();
    error BadSecret();
    error TooEarly();
    error BadParams();

    function lockId(address sender, bytes32 hashLock) public pure returns (bytes32) {
        return keccak256(abi.encode(sender, hashLock));
    }

    function lock(
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) external nonReentrant returns (bytes32) {
        _validateLock(msg.sender, token, recipient, amount, hashLock, deadline);
        return _lock(msg.sender, token, recipient, amount, hashLock, deadline);
    }

    function claim(bytes32 id, bytes32 secret) external nonReentrant {
        Lock storage lockData = locks[id];
        if (lockData.state != State.Locked) revert NotLocked();
        if (sha256(abi.encodePacked(secret)) != lockData.hashLock) revert BadSecret();

        lockData.state = State.Claimed;
        IERC20(lockData.token).safeTransfer(lockData.recipient, lockData.amount);
        emit Claimed(id, secret);
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage lockData = locks[id];
        if (lockData.state != State.Locked) revert NotLocked();
        if (block.timestamp < lockData.deadline) revert TooEarly();

        lockData.state = State.Refunded;
        IERC20(lockData.token).safeTransfer(lockData.sender, lockData.amount);
        emit Refunded(id);
    }

    function _lock(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) internal returns (bytes32) {
        bytes32 id = _createLock(owner, token, recipient, amount, hashLock, deadline);
        IERC20(token).safeTransferFrom(owner, address(this), amount);
        return id;
    }

    function _createLock(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) internal returns (bytes32) {
        bytes32 id = lockId(owner, hashLock);
        if (locks[id].state != State.None) revert AlreadyExists();

        locks[id] = Lock({
            token: token,
            sender: owner,
            recipient: recipient,
            amount: amount,
            hashLock: hashLock,
            deadline: deadline,
            state: State.Locked
        });

        emit Locked(id, owner, recipient, token, amount, hashLock, deadline);
        return id;
    }

    function _validateLock(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) internal view {
        if (
            token == address(0)
                || recipient == address(0)
                || recipient == owner
                || amount == 0
                || hashLock == bytes32(0)
                || deadline <= block.timestamp
        ) {
            revert BadParams();
        }
    }
}
