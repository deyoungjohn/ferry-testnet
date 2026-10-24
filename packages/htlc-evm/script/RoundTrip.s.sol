// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";

contract RoundTrip is Script {
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    function run() external {
        uint256 userKey = vm.envUint("USER_EVM_PRIVATE_KEY");
        uint256 solverKey = vm.envUint("SOLVER_EVM_PRIVATE_KEY");
        address user = vm.addr(userKey);
        address solver = vm.addr(solverKey);
        address token = vm.envOr("FERRY_USDC", address(0x036CbD53842c5426634e7929541eC2318f3dCF7e));
        address htlcAddress = vm.envAddress("FERRY_HTLC");
        uint256 amount = vm.envOr("FERRY_AMOUNT", uint256(1_000_000));
        FerryHTLC htlc = FerryHTLC(htlcAddress);

        require(token.code.length > 0, "token missing");
        require(htlcAddress.code.length > 0, "htlc missing");
        require(IERC20(token).balanceOf(user) >= amount, "user USDC too low");
        require(solver.balance > 0, "solver ETH missing");

        uint64 deadline = uint64(block.timestamp + 2 hours);
        uint256 intentDeadline = block.timestamp + 1 hours;
        uint256 permitDeadline = block.timestamp + 2 hours;
        bytes32 secret = keccak256(
            abi.encodePacked(block.timestamp, block.prevrandao, user, solver, htlcAddress)
        );
        bytes32 hashLock = sha256(abi.encodePacked(secret));
        bytes32 id = htlc.lockId(user, hashLock);

        bytes32 tokenDomain = _domainSeparator(token);
        uint256 nonce = IERC20Permit(token).nonces(user);
        bytes32 permitDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenDomain,
                keccak256(
                    abi.encode(PERMIT_TYPEHASH, user, htlcAddress, amount, nonce, permitDeadline)
                )
            )
        );
        (uint8 pv, bytes32 pr, bytes32 ps) = vm.sign(userKey, permitDigest);

        bytes32 intentDigest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                htlc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        htlc.LOCK_INTENT_TYPEHASH(),
                        token,
                        user,
                        amount,
                        hashLock,
                        deadline,
                        intentDeadline
                    )
                )
            )
        );
        (uint8 iv, bytes32 ir, bytes32 intentS) = vm.sign(userKey, intentDigest);

        console2.log("user:", user);
        console2.log("solver:", solver);
        console2.log("htlc:", htlcAddress);
        console2.log("amount:", amount);
        console2.log("lockId:");
        console2.logBytes32(id);
        console2.log("hashLock:");
        console2.logBytes32(hashLock);
        console2.log("user ETH before:", user.balance);
        console2.log("user USDC before:", IERC20(token).balanceOf(user));

        vm.broadcast(solverKey);
        bytes32 lockedId = htlc.lockWithIntent(
            user,
            token,
            user,
            amount,
            hashLock,
            deadline,
            intentDeadline,
            abi.encodePacked(ir, intentS, iv),
            permitDeadline,
            pv,
            pr,
            ps
        );
        require(lockedId == id, "unexpected lock id");

        vm.broadcast(solverKey);
        htlc.claim(id, secret);

        console2.log("user ETH after:", user.balance);
        console2.log("user USDC after:", IERC20(token).balanceOf(user));
        console2.log("htlc USDC after:", IERC20(token).balanceOf(htlcAddress));
        (
            address lockToken,
            address lockSender,
            address lockRecipient,
            uint256 lockAmount,
            bytes32 lockHash,
            uint64 lockDeadline,
            FerryHTLC.State lockState
        ) = htlc.locks(id);
        console2.log("locked state:", uint8(lockState));
        require(
            lockToken == token && lockSender == user && lockRecipient == user
                && lockAmount == amount && lockHash == hashLock && lockDeadline == deadline,
            "lock mismatch"
        );
    }

    function _domainSeparator(address token) internal view returns (bytes32 domain) {
        (bool ok, bytes memory result) =
            token.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        require(ok && result.length == 32, "no EIP-712 domain");
        domain = abi.decode(result, (bytes32));
    }
}
