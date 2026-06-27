// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../ConditionalPriceFeed.sol";
import "../ConditionalEscrow.sol";

/**
 * Deploys the conditional-contract layer (ConditionalPriceFeed + ConditionalEscrow).
 * Independent of ERC8183 / BondHook — no proxy whitelisting needed.
 *
 * Same wallet pattern as Deploy.s.sol: deployer == oracle (ORACLE_PRIVATE_KEY).
 */
contract DeployConditional is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("ORACLE_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address usdc        = vm.envAddress("USDC_ADDRESS");
        address admin       = deployer;
        address oracle      = deployer;

        vm.startBroadcast(deployerKey);

        // 1. Feed first — escrow's constructor needs its address
        ConditionalPriceFeed feed = new ConditionalPriceFeed(admin, oracle);

        // 2. Escrow references the feed
        ConditionalEscrow escrow = new ConditionalEscrow(usdc, address(feed));

        vm.stopBroadcast();

        console.log("ConditionalPriceFeed deployed:", address(feed));
        console.log("ConditionalEscrow deployed:   ", address(escrow));
        console.log("USDC:                         ", usdc);
        console.log("Admin/Oracle (deployer):      ", deployer);
    }
}
