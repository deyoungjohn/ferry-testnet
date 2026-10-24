// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { FerryHTLC } from "../../src/FerryHTLC.sol";
import { MockERC20 } from "../mocks/MockERC20.sol";

contract FerryHTLCHandler is Test {
    FerryHTLC public immutable htlc;
    MockERC20 public immutable token;

    address[] public senders;
    address[] public recipients;
    bytes32[] public ids;
    mapping(bytes32 => bytes32) public secrets;
    mapping(bytes32 => bool) public resolved;

    uint256 public sumLocked;
    bool public doubleResolved;
    bool public badDestination;

    constructor(FerryHTLC htlc_, MockERC20 token_) {
        htlc = htlc_;
        token = token_;

        senders.push(address(0x1001));
        senders.push(address(0x1002));
        senders.push(address(0x1003));
        recipients.push(address(0x2001));
        recipients.push(address(0x2002));
        recipients.push(address(0x2003));

        for (uint256 i = 0; i < senders.length; i++) {
            token.mint(senders[i], 1e30);
            vm.prank(senders[i]);
            token.approve(address(htlc), type(uint256).max);
        }
    }

    function lock(
        uint256 senderSeed,
        uint256 recipientSeed,
        uint256 amountSeed,
        uint256 deadlineSeed
    ) external {
        address sender = senders[senderSeed % senders.length];
        address recipient = recipients[recipientSeed % recipients.length];
        uint256 amount = bound(amountSeed, 1, 1_000e6);
        uint64 deadline = uint64(block.timestamp + bound(deadlineSeed, 1, 7 days));
        bytes32 secret = keccak256(
            abi.encode(
                senderSeed, recipientSeed, amountSeed, deadlineSeed, block.timestamp, ids.length
            )
        );
        bytes32 hashLock = sha256(abi.encodePacked(secret));
        bytes32 id = htlc.lockId(sender, hashLock);

        if (_state(id) != FerryHTLC.State.None) return;

        vm.prank(sender);
        htlc.lock(address(token), recipient, amount, hashLock, deadline);

        ids.push(id);
        secrets[id] = secret;
        sumLocked += amount;
    }

    function resolve(uint256 idSeed, uint256 modeSeed) external {
        if (ids.length == 0) return;

        bytes32 id = ids[idSeed % ids.length];
        if (resolved[id]) return;

        (
            address lockToken,
            address sender,
            address recipient,
            uint256 amount,,
            uint64 deadline,
            FerryHTLC.State state
        ) = htlc.locks(id);
        if (state != FerryHTLC.State.Locked || lockToken != address(token)) return;

        bool claimMode = modeSeed % 2 == 0;
        if (!claimMode && block.timestamp < deadline) vm.warp(deadline);

        uint256 beforeBalance = token.balanceOf(claimMode ? recipient : sender);
        if (claimMode) {
            htlc.claim(id, secrets[id]);
        } else {
            htlc.refund(id);
        }
        uint256 afterBalance = token.balanceOf(claimMode ? recipient : sender);

        if (afterBalance - beforeBalance != amount) badDestination = true;

        resolved[id] = true;
        sumLocked -= amount;
    }

    function resolveAgain(uint256 idSeed, uint256 modeSeed) external {
        if (ids.length == 0) return;

        bytes32 id = ids[idSeed % ids.length];
        if (!resolved[id]) return;

        FerryHTLC.State stateBefore = _state(id);
        try htlc.claim(id, secrets[id]) {
            doubleResolved = true;
        } catch { }
        try htlc.refund(id) {
            doubleResolved = true;
        } catch { }

        if (_state(id) != stateBefore) doubleResolved = true;
    }

    function _state(bytes32 id) internal view returns (FerryHTLC.State state) {
        (,,,,,, state) = htlc.locks(id);
    }
}
