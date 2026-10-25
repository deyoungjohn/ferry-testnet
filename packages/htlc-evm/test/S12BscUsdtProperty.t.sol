// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";
import { MockNoReturnToken } from "./mocks/MockNoReturnToken.sol";

contract S12BscUsdtPropertyTest is Test {
    FerryHTLC public htlc;
    MockNoReturnToken public bscUsdt;

    address public user = makeAddr("user");
    address public recipient = makeAddr("recipient");
    address public relayer = makeAddr("relayer");

    bytes32 public secret = keccak256("bsc-usdt-secret-s12");
    bytes32 public hashLock = sha256(abi.encodePacked(secret));
    uint64 public deadline;

    // 25 USDT in 18 decimals (matching @ferry/core bsc18 fixture)
    uint256 public constant CANONICAL_AMOUNT_18 = 25 * 10 ** 18;

    function setUp() public {
        htlc = new FerryHTLC();
        // BSC USDT is 18 decimals, no return value on transfer/transferFrom
        bscUsdt = new MockNoReturnToken("Tether USD", "USDT", 18);
        deadline = uint64(block.timestamp + 1 hours);
    }

    function test_s12_bscUsdt_18decimals_lockAndClaim() public {
        bscUsdt.mint(user, CANONICAL_AMOUNT_18);
        vm.startPrank(user);
        bscUsdt.approve(address(htlc), CANONICAL_AMOUNT_18);
        bytes32 id = htlc.lock(address(bscUsdt), recipient, CANONICAL_AMOUNT_18, hashLock, deadline);
        vm.stopPrank();

        assertEq(
            bscUsdt.balanceOf(address(htlc)),
            CANONICAL_AMOUNT_18,
            "HTLC must hold exact 18-decimal amount"
        );

        vm.prank(relayer);
        htlc.claim(id, secret);

        assertEq(
            bscUsdt.balanceOf(recipient),
            CANONICAL_AMOUNT_18,
            "Recipient must receive exact 18-decimal amount without truncation"
        );
        assertEq(bscUsdt.balanceOf(address(htlc)), 0, "HTLC balance must be 0");
    }

    function test_s12_bscUsdt_18decimals_lockAndRefund() public {
        bscUsdt.mint(user, CANONICAL_AMOUNT_18);
        vm.startPrank(user);
        bscUsdt.approve(address(htlc), CANONICAL_AMOUNT_18);
        bytes32 id = htlc.lock(address(bscUsdt), recipient, CANONICAL_AMOUNT_18, hashLock, deadline);
        vm.stopPrank();

        vm.warp(deadline + 1);

        vm.prank(relayer);
        htlc.refund(id);

        assertEq(
            bscUsdt.balanceOf(user),
            CANONICAL_AMOUNT_18,
            "User must receive exact refunded 18-decimal amount"
        );
        assertEq(bscUsdt.balanceOf(address(htlc)), 0, "HTLC balance must be 0");
    }

    function testFuzz_s12_bscUsdt_exactAmountPreservation(uint256 amount) public {
        // Bound between 1 wei and 1,000,000 USDT (1e24 wei)
        vm.assume(amount >= 1 && amount <= 1_000_000 * 10 ** 18);

        bscUsdt.mint(user, amount);
        vm.startPrank(user);
        bscUsdt.approve(address(htlc), amount);
        bytes32 id = htlc.lock(address(bscUsdt), recipient, amount, hashLock, deadline);
        vm.stopPrank();

        assertEq(bscUsdt.balanceOf(address(htlc)), amount, "HTLC locked balance exact");

        vm.prank(relayer);
        htlc.claim(id, secret);

        assertEq(bscUsdt.balanceOf(recipient), amount, "Recipient balance exact without rounding");
    }
}
