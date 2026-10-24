// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Test } from "forge-std/Test.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";

contract CrossCheckVectorsTest is Test {
    address internal constant SENDER = 0x3333333333333333333333333333333333333333;
    address internal constant TOKEN = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant RECIPIENT = 0x2222222222222222222222222222222222222222;
    address internal constant VERIFYING_CONTRACT = 0x1111111111111111111111111111111111111111;

    bytes32 internal constant XV_001_HASH_LOCK =
        0x72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793;
    bytes32 internal constant XV_002_LOCK_ID =
        0xf5cb22ed96205d2b9eb6649d8c1b3c43d5e6ad317915415c63dd8e9f484fb2ff;
    bytes32 internal constant XV_003_TYPEHASH =
        0x206bb7e43cb544526c2f09c034e6cd69fc2a725741b60f6348ae53779283d07d;
    bytes32 internal constant XV_003_DOMAIN_SEPARATOR =
        0xbf195c1a437f5f4f77ecbe2caf7a567fcc9db67b40f59574c5ae899d423de199;
    bytes32 internal constant XV_003_DIGEST =
        0xe4fb51869933d8b897c00af89e7adb36d6469c5c1b9b983b15e34e4d5bbf0150;

    function test_XV_001_secretHash() public pure {
        bytes32 secret = bytes32(0x0101010101010101010101010101010101010101010101010101010101010101);
        assertEq(sha256(abi.encodePacked(secret)), XV_001_HASH_LOCK);
    }

    function test_XV_002_lockId() public {
        FerryHTLC htlc = new FerryHTLC();
        assertEq(htlc.lockId(SENDER, XV_001_HASH_LOCK), XV_002_LOCK_ID);
    }

    function test_XV_003_intentDigest() public {
        vm.chainId(84532);
        FerryHTLC fixedHtlc = FerryHTLC(VERIFYING_CONTRACT);
        vm.etch(VERIFYING_CONTRACT, address(new FerryHTLC()).code);

        assertEq(fixedHtlc.LOCK_INTENT_TYPEHASH(), XV_003_TYPEHASH);
        assertEq(fixedHtlc.DOMAIN_SEPARATOR(), XV_003_DOMAIN_SEPARATOR);

        bytes32 structHash = keccak256(
            abi.encode(
                XV_003_TYPEHASH,
                TOKEN,
                RECIPIENT,
                25_000_000,
                XV_001_HASH_LOCK,
                uint64(1_800_000_000),
                uint256(1_799_990_000)
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", fixedHtlc.DOMAIN_SEPARATOR(), structHash));
        assertEq(digest, XV_003_DIGEST);
    }
}
