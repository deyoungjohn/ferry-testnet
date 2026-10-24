// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

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

    bytes32 public constant LOCK_INTENT_TYPEHASH = keccak256(
        "LockIntent(address token,address recipient,uint256 amount,bytes32 hashLock,uint64 deadline,uint256 intentDeadline)"
    );

    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant NAME_HASH = keccak256("FerryHTLC");
    bytes32 private constant VERSION_HASH = keccak256("1");

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
    error IntentExpired();
    error InvalidIntentSignature();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)
            )
        );
    }

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

    function lockWithIntent(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline,
        uint256 intentDeadline,
        bytes calldata intentSig,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32) {
        if (block.timestamp > intentDeadline) revert IntentExpired();

        _validateLock(owner, token, recipient, amount, hashLock, deadline);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        LOCK_INTENT_TYPEHASH,
                        token,
                        recipient,
                        amount,
                        hashLock,
                        deadline,
                        intentDeadline
                    )
                )
            )
        );

        if (!SignatureChecker.isValidSignatureNow(owner, digest, intentSig)) {
            revert InvalidIntentSignature();
        }

        bytes32 id = _createLock(owner, token, recipient, amount, hashLock, deadline);
        _tryPermit(token, owner, amount, permitDeadline, v, r, s);
        IERC20(token).safeTransferFrom(owner, address(this), amount);
        return id;
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

    function _tryPermit(
        address token,
        address owner,
        uint256 amount,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal {
        try IERC20Permit(token).permit(owner, address(this), amount, permitDeadline, v, r, s) { }
            catch { }
    }

    function _lock(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) internal returns (bytes32 id) {
        id = _createLock(owner, token, recipient, amount, hashLock, deadline);
        IERC20(token).safeTransferFrom(owner, address(this), amount);
    }

    function _createLock(
        address owner,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline
    ) internal returns (bytes32 id) {
        id = lockId(owner, hashLock);
        locks[id] = Lock(token, owner, recipient, amount, hashLock, deadline, State.Locked);
        emit Locked(id, owner, recipient, token, amount, hashLock, deadline);
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
            owner == address(0) || token == address(0) || amount == 0 || recipient == address(0)
                || deadline <= block.timestamp
        ) revert BadParams();
        if (locks[lockId(owner, hashLock)].state != State.None) revert AlreadyExists();
    }
}
