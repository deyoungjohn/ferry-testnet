// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { FerryHTLC } from "../../src/FerryHTLC.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";
import { FerryHTLCHandler } from "./FerryHTLCHandler.sol";

contract FerryHTLCInvariantTest is Test {
    FerryHTLC internal htlc;
    MockERC20 internal token;
    FerryHTLCHandler internal handler;

    function setUp() public {
        htlc = new FerryHTLC();
        token = new MockERC20("Mock USDC", "mUSDC", 6);
        handler = new FerryHTLCHandler(htlc, token);

        targetContract(address(handler));
    }

    function invariant_balanceEqualsSumLocked() public view {
        assertEq(token.balanceOf(address(htlc)), handler.sumLocked());
    }

    function invariant_eachLockResolvesAtMostOnce() public view {
        assertFalse(handler.doubleResolved());
    }

    function invariant_fundsOnlyGoToRecipientOrSender() public view {
        assertFalse(handler.badDestination());
    }
}
