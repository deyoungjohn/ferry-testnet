// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";

contract S14UsdtMainnetForkTest is Test {
    address public constant MAINNET_USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    string public constant DEFAULT_MAINNET_RPC = "https://ethereum-rpc.publicnode.com";

    FerryHTLC public htlc;
    address public user = makeAddr("user");
    address public recipient = makeAddr("recipient");
    address public relayer = makeAddr("relayer");

    bytes32 public secret = keccak256("usdt-test-secret-14");
    bytes32 public hashLock = sha256(abi.encodePacked(secret));
    uint256 public amount = 1_000_000; // 1 USDT (6 decimals)
    uint64 public deadline;

    function setUp() public {
        string memory rpcUrl = vm.envOr("MAINNET_RPC_URL", DEFAULT_MAINNET_RPC);
        try vm.createSelectFork(rpcUrl) {
        // fork created
        }
        catch {
            // Offline / RPC unavailable: skip fork tests gracefully
            return;
        }

        htlc = new FerryHTLC();
        deadline = uint64(block.timestamp + 1 hours);
        deal(MAINNET_USDT, user, 100_000_000); // 100 USDT
    }

    function test_s14_usdt_noReturnValue_lockAndClaim() public {
        if (block.chainid != 1) {
            vm.skip(true);
            return;
        }

        vm.startPrank(user);
        // Step 1: User approves USDT to FerryHTLC
        (bool appOk,) = MAINNET_USDT.call(
            abi.encodeWithSignature("approve(address,uint256)", address(htlc), amount)
        );
        require(appOk, "approve failed");

        // Step 2: Lock via direct lock()
        bytes32 id = htlc.lock(MAINNET_USDT, recipient, amount, hashLock, deadline);
        vm.stopPrank();

        assertEq(IERC20(MAINNET_USDT).balanceOf(address(htlc)), amount, "HTLC balance mismatch");

        // Step 3: Relayer claims with secret
        uint256 recipientBefore = IERC20(MAINNET_USDT).balanceOf(recipient);
        vm.prank(relayer);
        htlc.claim(id, secret);

        uint256 recipientAfter = IERC20(MAINNET_USDT).balanceOf(recipient);
        assertEq(recipientAfter - recipientBefore, amount, "claim amount mismatch");
        assertEq(IERC20(MAINNET_USDT).balanceOf(address(htlc)), 0, "HTLC balance should be 0");
    }

    function test_s14_usdt_noReturnValue_lockAndRefund() public {
        if (block.chainid != 1) {
            vm.skip(true);
            return;
        }

        vm.startPrank(user);
        (bool appOk,) = MAINNET_USDT.call(
            abi.encodeWithSignature("approve(address,uint256)", address(htlc), amount)
        );
        require(appOk, "approve failed");

        bytes32 id = htlc.lock(MAINNET_USDT, recipient, amount, hashLock, deadline);
        vm.stopPrank();

        assertEq(IERC20(MAINNET_USDT).balanceOf(address(htlc)), amount, "HTLC balance mismatch");

        // Warp past deadline
        vm.warp(deadline + 1);

        uint256 userBefore = IERC20(MAINNET_USDT).balanceOf(user);
        vm.prank(relayer);
        htlc.refund(id);

        uint256 userAfter = IERC20(MAINNET_USDT).balanceOf(user);
        assertEq(userAfter - userBefore, amount, "refund amount mismatch");
        assertEq(IERC20(MAINNET_USDT).balanceOf(address(htlc)), 0, "HTLC balance should be 0");
    }

    function test_s14_usdt_noPermitSupport() public {
        if (block.chainid != 1) {
            vm.skip(true);
            return;
        }

        // Verify that DOMAIN_SEPARATOR() does not exist or reverts on mainnet USDT
        (bool ok,) = MAINNET_USDT.staticcall(abi.encodeWithSignature("DOMAIN_SEPARATOR()"));
        assertTrue(!ok, "Mainnet USDT should not support DOMAIN_SEPARATOR");

        // Verify that permit() does not exist or reverts on mainnet USDT
        (bool permitOk,) = MAINNET_USDT.call(
            abi.encodeWithSignature(
                "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)",
                user,
                address(htlc),
                amount,
                deadline,
                27,
                bytes32(0),
                bytes32(0)
            )
        );
        assertTrue(!permitOk, "Mainnet USDT should not support permit");
    }
}
