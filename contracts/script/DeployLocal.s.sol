// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ClearingHub} from "../src/ClearingHub.sol";
import {MockStablecoin} from "../src/MockStablecoin.sol";

/// Local anvil only: deploys the hub plus a mock USDC and writes deployments/31337.json.
contract DeployLocal is Script {
    function run() external {
        require(block.chainid == 31337, "DeployLocal is for anvil only");
        vm.startBroadcast();
        ClearingHub hub = new ClearingHub();
        MockStablecoin usdc = new MockStablecoin();
        vm.stopBroadcast();

        string memory json = vm.serializeAddress("deployment", "clearingHub", address(hub));
        json = vm.serializeAddress("deployment", "token", address(usdc));
        json = vm.serializeUint("deployment", "chainId", block.chainid);
        json = vm.serializeUint("deployment", "blockNumber", block.number);
        vm.writeJson(json, "deployments/31337.json");
        console2.log("ClearingHub", address(hub));
        console2.log("MockStablecoin", address(usdc));
    }
}
