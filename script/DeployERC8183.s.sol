// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/ERC8183.sol";

contract DeployERC8183 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("ORACLE_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address treasury    = vm.envAddress("TREASURY_ADDRESS");
        address bondHook    = vm.envAddress("BOND_HOOK_ADDRESS");
        address usdc        = vm.envAddress("USDC_ADDRESS");

        vm.startBroadcast(deployerKey);

        ERC8183 impl = new ERC8183();

        bytes memory initData = abi.encodeCall(
            ERC8183.initialize,
            (treasury, deployer)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        ERC8183 erc8183 = ERC8183(address(proxy));

        erc8183.setHookWhitelist(bondHook, true);
        erc8183.setPaymentTokenAllowed(usdc, true);

        vm.stopBroadcast();

        console.log("ERC8183 impl: ", address(impl));
        console.log("ERC8183 proxy:", address(proxy));
    }
}
