// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { FerryHTLC } from "../src/FerryHTLC.sol";

contract Deploy is Script {
    bytes32 public constant SALT = keccak256("ferry-htlc.v1");

    function run() external {
        require(CREATE2_FACTORY.code.length > 0, "canonical CREATE2 factory missing");

        bytes memory initCode = type(FerryHTLC).creationCode;
        address predicted = vm.computeCreate2Address(SALT, keccak256(initCode), CREATE2_FACTORY);
        console2.log("FerryHTLC predicted:", predicted);

        uint256 deployerKey = vm.envOr("DEPLOYER_EVM_PRIVATE_KEY", uint256(0));
        if (deployerKey == 0) {
            console2.log("DEPLOYER_EVM_PRIVATE_KEY missing; prediction only");
            return;
        }

        address deployer = vm.addr(deployerKey);
        console2.log("deployer:", deployer);
        console2.log("deployer balance:", deployer.balance);
        if (deployer.balance == 0) {
            console2.log("deployer unfunded; prediction only");
            return;
        }

        vm.broadcast(deployerKey);
        (bool success, bytes memory result) = CREATE2_FACTORY.call{ gas: 1_500_000 }(
            abi.encodePacked(SALT, initCode)
        );
        require(success, "CREATE2 deployment failed");
        address deployed = result.length == 20 ? address(uint160(bytes20(result))) : abi.decode(result, (address));
        require(deployed == predicted, "unexpected CREATE2 address");

        console2.log("FerryHTLC deployed:", deployed);
    }
}
