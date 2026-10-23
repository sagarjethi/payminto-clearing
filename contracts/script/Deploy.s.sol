// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClearingHub} from "../src/ClearingHub.sol";

/// Deploys ClearingHub and records the address in deployments/<chainId>.json.
/// Usage: forge script script/Deploy.s.sol --rpc-url hashkey --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    function run() external returns (ClearingHub hub) {
        vm.startBroadcast();
        hub = new ClearingHub();
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("deployment", "clearingHub", address(hub));
        json = vm.serializeUint("deployment", "chainId", block.chainid);
        json = vm.serializeUint("deployment", "blockNumber", block.number);
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console2.log("ClearingHub", address(hub));
    }
}
