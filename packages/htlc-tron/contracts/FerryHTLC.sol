// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev TVM-safe token transfer library for TRC-20 tokens on TRON.
 * Handles both EVM void return (0 bytes) and TVM void return (32 zero bytes),
 * as well as standard tokens returning boolean true.
 */
library SafeTRC20 {
    error SafeTRC20FailedOperation(address token);

    function safeTransfer(address token, address to, uint256 value) internal {
        (bool success, bytes memory retData) = token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, value)
        );
        if (!success) revert SafeTRC20FailedOperation(token);
        if (retData.length > 0) {
            if (retData.length == 32) {
                uint256 retVal = abi.decode(retData, (uint256));
                if (retVal != 1 && retVal != 0) revert SafeTRC20FailedOperation(token);
            }
        }
    }

    function safeTransferFrom(address token, address from, address to, uint256 value) internal {
        (bool success, bytes memory retData) = token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value)
        );
        if (!success) revert SafeTRC20FailedOperation(token);
        if (retData.length > 0) {
            if (retData.length == 32) {
                uint256 retVal = abi.decode(retData, (uint256));
                if (retVal != 1 && retVal != 0) revert SafeTRC20FailedOperation(token);
            }
        }
    }
}

/**
 * @title FerryHTLC (Tron Port)
 * @notice Port of Ferry HTLC for TRON TVM.
 * Dropped lockWithIntent (per D-A3-006) as TRC-20 tokens (e.g. USDT) lack EIP-2612 permit;
 * standard approve + lock is used instead.
 * Uses SafeTRC20 to natively handle TVM return value quirks (e.g. USDT returning void/zeroes).
 */
contract FerryHTLC is ReentrancyGuard {

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
        SafeTRC20.safeTransfer(lockData.token, lockData.recipient, lockData.amount);
        emit Claimed(id, secret);
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage lockData = locks[id];
        if (lockData.state != State.Locked) revert NotLocked();
        if (block.timestamp < lockData.deadline) revert TooEarly();

        lockData.state = State.Refunded;
        SafeTRC20.safeTransfer(lockData.token, lockData.sender, lockData.amount);
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
        SafeTRC20.safeTransferFrom(token, owner, address(this), amount);
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
