// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { FerryHTLC } from "../../src/FerryHTLC.sol";

library Signatures {
    bytes32 internal constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    function permitDigest(
        address token,
        address owner,
        address spender,
        uint256 value,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                IERC20Permit(token).DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonce, deadline))
            )
        );
    }

    function intentDigest(
        FerryHTLC htlc,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashLock,
        uint64 deadline,
        uint256 intentDeadline
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                htlc.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        htlc.LOCK_INTENT_TYPEHASH(),
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
    }
}
