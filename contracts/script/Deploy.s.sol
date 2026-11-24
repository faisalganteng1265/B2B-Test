// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {MockUSDT} from "../src/MockUSDT.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Deploys mock stablecoins, funds the B2B client test wallets, and writes
/// deployments/<chainId>.json. Client wallets come from env CLIENT_WALLETS (comma separated).
contract Deploy is Script {
    uint256 internal constant INITIAL_BALANCE = 10_000_000e6; // 10M tokens per client wallet

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address[] memory clients = vm.envAddress("CLIENT_WALLETS", ",");

        vm.startBroadcast(pk);
        MockUSDT usdt = new MockUSDT(deployer);
        MockUSDC usdc = new MockUSDC(deployer);
        for (uint256 i = 0; i < clients.length; i++) {
            usdt.mint(clients[i], INITIAL_BALANCE);
            usdc.mint(clients[i], INITIAL_BALANCE);
        }
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "deployBlock", block.number);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "clientWallets", clients);
        string memory tokensJson;
        {
            string memory t = "tokens";
            vm.serializeAddress(t, "USDT", address(usdt));
            tokensJson = vm.serializeAddress(t, "USDC", address(usdc));
        }
        string memory json = vm.serializeString(obj, "tokens", tokensJson);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("USDT", address(usdt));
        console2.log("USDC", address(usdc));
        console2.log("written", path);
    }

}
