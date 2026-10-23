// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockUSDCWithPermit } from "./mocks/MockUSDCWithPermit.sol";
import { MockNoReturnToken } from "./mocks/MockNoReturnToken.sol";
import { MockSmartWallet } from "./mocks/MockSmartWallet.sol";
import { Signatures } from "./utils/Signatures.sol";

contract FerryHTLCTest is Test {
    uint256 internal constant AMOUNT = 25e6;
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant OTHER_PK = 0xB0B;
    address internal constant RECIPIENT = address(0xBEEF);
    address internal constant RELAYER = address(0xCAFE);

    FerryHTLC internal htlc;
    MockUSDCWithPermit internal usdc;
    address internal user;
    bytes32 internal secret;
    bytes32 internal hashLock;
    uint64 internal deadline;

    function setUp() public {
        htlc = new FerryHTLC();
        usdc = new MockUSDCWithPermit();
        user = vm.addr(USER_PK);
        secret = bytes32(uint256(0x1234));
        hashLock = sha256(abi.encodePacked(secret));
        deadline = uint64(block.timestamp + 1 days);

        usdc.mint(user, 1_000e6);
        vm.prank(user);
        usdc.approve(address(htlc), type(uint256).max);
    }

    function test_lock_storesLockAndTransfersFunds() public {
        uint256 beforeBalance = usdc.balanceOf(user);
        bytes32 id = _lockAsUser();

        FerryHTLC.Lock memory lockData = _getLock(id);
        assertEq(lockData.token, address(usdc));
        assertEq(lockData.sender, user);
        assertEq(lockData.recipient, RECIPIENT);
        assertEq(lockData.amount, AMOUNT);
        assertEq(lockData.hashLock, hashLock);
        assertEq(lockData.deadline, deadline);
        assertEq(uint8(lockData.state), uint8(FerryHTLC.State.Locked));
        assertEq(usdc.balanceOf(user), beforeBalance - AMOUNT);
        assertEq(usdc.balanceOf(address(htlc)), AMOUNT);
    }

    function test_claim_transfersToRecipient() public {
        bytes32 id = _lockAsUser();

        vm.prank(RELAYER);
        htlc.claim(id, secret);

        assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
        assertEq(usdc.balanceOf(address(htlc)), 0);
        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Claimed));
    }

    function test_claim_isPermissionless() public {
        bytes32 id = _lockAsUser();

        vm.prank(address(0xDEAD));
        htlc.claim(id, secret);

        assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
    }

    function test_claim_succeedsAfterDeadlineWhileLocked() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline + 1 hours);

        vm.prank(RELAYER);
        htlc.claim(id, secret);

        assertEq(usdc.balanceOf(RECIPIENT), AMOUNT);
    }

    function test_claim_wrongSecretReverts() public {
        bytes32 id = _lockAsUser();

        vm.expectRevert(FerryHTLC.BadSecret.selector);
        htlc.claim(id, bytes32(uint256(0xBAD)));

        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Locked));
    }

    function test_claim_twiceReverts() public {
        bytes32 id = _lockAsUser();
        htlc.claim(id, secret);

        vm.expectRevert(FerryHTLC.NotLocked.selector);
        htlc.claim(id, secret);
    }

    function test_claim_afterRefundReverts() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline);
        htlc.refund(id);

        vm.expectRevert(FerryHTLC.NotLocked.selector);
        htlc.claim(id, secret);
    }

    function test_refund_returnsFundsToSender() public {
        uint256 beforeBalance = usdc.balanceOf(user);
        bytes32 id = _lockAsUser();
        vm.warp(deadline);

        vm.prank(RELAYER);
        htlc.refund(id);

        assertEq(usdc.balanceOf(user), beforeBalance);
        assertEq(usdc.balanceOf(address(htlc)), 0);
        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Refunded));
    }

    function test_refund_atDeadlineSucceeds() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline);

        htlc.refund(id);

        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Refunded));
    }

    function test_refund_beforeDeadlineReverts() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline - 1);

        vm.expectRevert(FerryHTLC.TooEarly.selector);
        htlc.refund(id);
    }

    function test_refund_twiceReverts() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline);
        htlc.refund(id);

        vm.expectRevert(FerryHTLC.NotLocked.selector);
        htlc.refund(id);
    }

    function test_refund_afterClaimReverts() public {
        bytes32 id = _lockAsUser();
        htlc.claim(id, secret);
        vm.warp(deadline);

        vm.expectRevert(FerryHTLC.NotLocked.selector);
        htlc.refund(id);
    }

    function test_lock_zeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lock(address(usdc), RECIPIENT, 0, hashLock, deadline);
    }

    function test_lock_zeroRecipientReverts() public {
        vm.prank(user);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lock(address(usdc), address(0), AMOUNT, hashLock, deadline);
    }

    function test_lock_zeroTokenReverts() public {
        vm.prank(user);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lock(address(0), RECIPIENT, AMOUNT, hashLock, deadline);
    }

    function test_lock_pastDeadlineReverts() public {
        vm.prank(user);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lock(address(usdc), RECIPIENT, AMOUNT, hashLock, uint64(block.timestamp));
    }

    function test_lock_replayAfterRefundReverts() public {
        bytes32 id = _lockAsUser();
        vm.warp(deadline);
        htlc.refund(id);

        vm.prank(user);
        vm.expectRevert(FerryHTLC.AlreadyExists.selector);
        htlc.lock(address(usdc), RECIPIENT, AMOUNT, hashLock, uint64(block.timestamp + 1 days));
    }

    function test_lock_idIsBoundToSender() public {
        bytes32 id = _lockAsUser();

        uint256 otherPk = 0x0B0B;
        address other = vm.addr(otherPk);
        usdc.mint(other, AMOUNT);
        vm.prank(other);
        usdc.approve(address(htlc), AMOUNT);

        vm.prank(other);
        bytes32 otherId = htlc.lock(address(usdc), RECIPIENT, AMOUNT, hashLock, deadline);

        assertTrue(id != otherId);
        assertEq(htlc.lockId(user, hashLock), id);
        assertEq(htlc.lockId(other, hashLock), otherId);
    }

    function test_lock_noReturnTokenWorks() public {
        MockNoReturnToken token = new MockNoReturnToken("Tether USD", "USDT", 6);
        token.mint(user, AMOUNT);
        vm.prank(user);
        token.approve(address(htlc), AMOUNT);

        vm.prank(user);
        bytes32 id = htlc.lock(address(token), RECIPIENT, AMOUNT, hashLock, deadline);

        assertEq(token.balanceOf(address(htlc)), AMOUNT);
        htlc.claim(id, secret);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    function test_lockWithIntent_permitAndIntent() public {
        uint256 beforeBalance = usdc.balanceOf(user);
        uint256 permitDeadline = block.timestamp + 1 hours;
        uint256 intentDeadline = block.timestamp + 30 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(user, address(htlc), AMOUNT, permitDeadline);
        bytes memory intentSig = _signIntent(
            USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            permitDeadline,
            v,
            r,
            s
        );

        assertEq(usdc.balanceOf(user), beforeBalance - AMOUNT);
        assertEq(usdc.balanceOf(address(htlc)), AMOUNT);
        assertEq(_getLock(id).sender, user);
        assertEq(usdc.allowance(user, address(htlc)), 0);
    }

    function test_lockWithIntent_frontRunPermitStillLocks() public {
        uint256 permitDeadline = block.timestamp + 1 hours;
        uint256 intentDeadline = block.timestamp + 30 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(user, address(htlc), AMOUNT, permitDeadline);
        bytes memory intentSig = _signIntent(
            USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(address(0xF00D));
        usdc.permit(user, address(htlc), AMOUNT, permitDeadline, v, r, s);

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            permitDeadline,
            v,
            r,
            s
        );

        assertEq(usdc.balanceOf(address(htlc)), AMOUNT);
        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Locked));
    }

    function test_lockWithIntent_wrongSignerReverts() public {
        uint256 permitDeadline = block.timestamp + 1 hours;
        uint256 intentDeadline = block.timestamp + 30 minutes;
        bytes memory intentSig = _signIntent(
            OTHER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            permitDeadline,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_changedRecipientReverts() public {
        _expectChangedIntentReverts(address(0x1111), AMOUNT, hashLock, deadline);
    }

    function test_lockWithIntent_changedAmountReverts() public {
        _expectChangedIntentReverts(RECIPIENT, AMOUNT + 1, hashLock, deadline);
    }

    function test_lockWithIntent_changedHashLockReverts() public {
        _expectChangedIntentReverts(RECIPIENT, AMOUNT, bytes32(uint256(0x9999)), deadline);
    }

    function test_lockWithIntent_changedDeadlineReverts() public {
        _expectChangedIntentReverts(RECIPIENT, AMOUNT, hashLock, deadline + 1);
    }

    function test_lockWithIntent_expiredIntentReverts() public {
        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.IntentExpired.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            block.timestamp - 1,
            "",
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_replayReverts() public {
        uint256 permitDeadline = block.timestamp + 1 hours;
        uint256 intentDeadline = block.timestamp + 30 minutes;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(user, address(htlc), AMOUNT, permitDeadline);
        bytes memory intentSig = _signIntent(
            USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            permitDeadline,
            v,
            r,
            s
        );

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.AlreadyExists.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_zeroOwnerReverts() public {
        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lockWithIntent(
            address(0),
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            block.timestamp + 30 minutes,
            "",
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_zeroAmountReverts() public {
        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.BadParams.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            0,
            hashLock,
            deadline,
            block.timestamp + 30 minutes,
            "",
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_noReturnTokenWorks() public {
        MockNoReturnToken token = new MockNoReturnToken("Tether USD", "USDT", 6);
        token.mint(user, AMOUNT);
        vm.prank(user);
        token.approve(address(htlc), AMOUNT);

        uint256 intentDeadline = block.timestamp + 30 minutes;
        bytes memory intentSig = _signIntent(
            USER_PK, address(token), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            user,
            address(token),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );

        assertEq(token.balanceOf(address(htlc)), AMOUNT);
        htlc.claim(id, secret);
        assertEq(token.balanceOf(RECIPIENT), AMOUNT);
    }

    function test_lockWithIntent_noReturnToken18DecimalsWorks() public {
        uint256 amount = 25e18;
        MockNoReturnToken token = new MockNoReturnToken("BSC-USD", "USDT", 18);
        token.mint(user, amount);
        vm.prank(user);
        token.approve(address(htlc), amount);

        uint256 intentDeadline = block.timestamp + 30 minutes;
        bytes memory intentSig = _signIntent(
            USER_PK, address(token), RECIPIENT, amount, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            user,
            address(token),
            RECIPIENT,
            amount,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );

        assertEq(token.balanceOf(address(htlc)), amount);
        htlc.claim(id, secret);
        assertEq(token.balanceOf(RECIPIENT), amount);
    }

    function test_lockWithIntent_smartWalletSignatureWorks() public {
        uint256 smartWalletPk = 0x5A5A;
        address smartWalletOwner = vm.addr(smartWalletPk);
        MockSmartWallet wallet = new MockSmartWallet(smartWalletOwner);

        usdc.mint(address(wallet), AMOUNT);
        vm.prank(smartWalletOwner);
        wallet.approveToken(address(usdc), address(htlc), AMOUNT);

        uint256 intentDeadline = block.timestamp + 30 minutes;
        bytes memory intentSig = _signIntent(
            smartWalletPk, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, intentDeadline
        );

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            address(wallet),
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            intentDeadline,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );

        assertEq(_getLock(id).sender, address(wallet));
        assertEq(usdc.balanceOf(address(htlc)), AMOUNT);
    }

    function test_lockWithIntent_changedTokenReverts() public {
        MockERC20 otherToken = new MockERC20("Other", "OTH", 6);
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        htlc.lockWithIntent(
            user,
            address(otherToken),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            expiry,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_changedIntentDeadlineReverts() public {
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            expiry + 1,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_contractAddressBound() public {
        FerryHTLC other = new FerryHTLC();
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        other.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            expiry,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_chainIdBound() public {
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.chainId(84532);
        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            expiry,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }

    function test_lockWithIntent_expiredPermitWithAllowanceStillLocks() public {
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.prank(RELAYER);
        bytes32 id = htlc.lockWithIntent(
            user,
            address(usdc),
            RECIPIENT,
            AMOUNT,
            hashLock,
            deadline,
            expiry,
            intentSig,
            block.timestamp - 1,
            0,
            bytes32(0),
            bytes32(0)
        );

        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Locked));
    }

    function testFuzz_claim_onlyWithMatchingSecret(
        bytes32 fuzzSecret,
        bytes32 wrongSecret,
        uint96 fuzzAmount,
        uint64 deadlineOffset
    ) public {
        vm.assume(fuzzSecret != wrongSecret);
        uint256 amount = bound(uint256(fuzzAmount), 1, 1_000e6);
        uint64 fuzzDeadline = uint64(block.timestamp + bound(uint256(deadlineOffset), 1, 365 days));
        bytes32 fuzzHashLock = sha256(abi.encodePacked(fuzzSecret));

        vm.prank(user);
        bytes32 id = htlc.lock(address(usdc), RECIPIENT, amount, fuzzHashLock, fuzzDeadline);

        vm.expectRevert(FerryHTLC.BadSecret.selector);
        htlc.claim(id, wrongSecret);

        htlc.claim(id, fuzzSecret);
        assertEq(usdc.balanceOf(RECIPIENT), amount);
        assertEq(uint8(_getLock(id).state), uint8(FerryHTLC.State.Claimed));
    }

    function _lockAsUser() internal returns (bytes32 id) {
        vm.prank(user);
        id = htlc.lock(address(usdc), RECIPIENT, AMOUNT, hashLock, deadline);
    }

    function _getLock(bytes32 id) internal view returns (FerryHTLC.Lock memory lockData) {
        (
            address token,
            address sender,
            address recipient,
            uint256 amount,
            bytes32 storedHashLock,
            uint64 storedDeadline,
            FerryHTLC.State state
        ) = htlc.locks(id);
        lockData =
            FerryHTLC.Lock(token, sender, recipient, amount, storedHashLock, storedDeadline, state);
    }

    function _signPermit(address owner, address spender, uint256 amount, uint256 permitDeadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = usdc.nonces(owner);
        bytes32 digest =
            Signatures.permitDigest(address(usdc), owner, spender, amount, nonce, permitDeadline);
        return vm.sign(USER_PK, digest);
    }

    function _signIntent(
        uint256 signerPk,
        address token,
        address intentRecipient,
        uint256 amount,
        bytes32 intentHashLock,
        uint64 intentDeadline,
        uint256 intentExpiry
    ) internal view returns (bytes memory) {
        bytes32 digest = Signatures.intentDigest(
            htlc, token, intentRecipient, amount, intentHashLock, intentDeadline, intentExpiry
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectChangedIntentReverts(
        address intentRecipient,
        uint256 intentAmount,
        bytes32 intentHashLock,
        uint64 intentDeadline
    ) internal {
        uint256 expiry = block.timestamp + 30 minutes;
        bytes memory intentSig =
            _signIntent(USER_PK, address(usdc), RECIPIENT, AMOUNT, hashLock, deadline, expiry);

        vm.prank(RELAYER);
        vm.expectRevert(FerryHTLC.InvalidIntentSignature.selector);
        htlc.lockWithIntent(
            user,
            address(usdc),
            intentRecipient,
            intentAmount,
            intentHashLock,
            intentDeadline,
            expiry,
            intentSig,
            0,
            0,
            bytes32(0),
            bytes32(0)
        );
    }
}
