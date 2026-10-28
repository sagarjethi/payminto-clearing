// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

/// Deploys ClearingHub deterministically and records the address in deployments/<chainId>.json.
/// CREATE2 through the canonical deployer (0x4e59b44847b379578588920cA78FbF26c0B4956C, present on 31337, 133 and 177)
/// with a fixed salt gives the hub the same address on every chain, as long as the bytecode is identical.
/// Usage: forge script script/Deploy.s.sol --rpc-url hashkey --broadcast --account payminto-deployer
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("payminto.clearing.v1");

    function run() external returns (ClearingHub hub) {
        vm.startBroadcast();
        hub = new ClearingHub{salt: SALT}();
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("deployment", "clearingHub", address(hub));
        json = vm.serializeUint("deployment", "chainId", block.chainid);
        json = vm.serializeUint("deployment", "blockNumber", block.number);
        // A fresh clone has no deployments/ directory content; make sure it exists before writing.
        vm.createDir("deployments", true);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("ClearingHub", address(hub));
    }
}
