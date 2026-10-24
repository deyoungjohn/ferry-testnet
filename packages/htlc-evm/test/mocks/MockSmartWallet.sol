// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract MockSmartWallet {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;
    bytes4 private constant INVALID_VALUE = 0xffffffff;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        IERC20(token).approve(spender, amount);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(hash, signature);
        if (error == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC_VALUE;
        return INVALID_VALUE;
    }
}
