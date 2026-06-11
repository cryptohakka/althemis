// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import "../src/BondHook.sol";

// Interface for ERC8183 initialization (UUPS proxy)
interface IERC8183Init {
    function initialize(address treasury) external;
    function setHookWhitelist(address hook, bool status) external;
    function setPaymentTokenAllowlist(address token, bool status) external;
    function grantRole(bytes32 role, address account) external;
}

contract DeployAlthemis is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("ORACLE_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);
        address usdc        = vm.envAddress("USDC_ADDRESS");
        address treasury    = vm.envOr("TREASURY_ADDRESS", deployer);

        vm.startBroadcast(deployerKey);

        // ── 1. Deploy ERC8183 implementation + UUPS proxy ──────
        // Clone the ref impl (assumes compiled artifact is available)
        // For Arc testnet: use pre-built bytecode or compile with forge
        // Implementation deploy handled by forge script's --broadcast
        // Here we reference the already-deployed proxy if available,
        // otherwise deploy fresh.
        address erc8183Proxy = vm.envOr("ERC8183_ADDRESS", address(0));

        // ── 2. Deploy BondHook ─────────────────────────────────
        BondHook hook = new BondHook(
            usdc,
            treasury,
            deployer,       // ORACLE_ROLE → oracle wallet (= deployer for now)
            erc8183Proxy    // ACP_ROLE → ERC8183 proxy
        );

        // ── 3. Whitelist BondHook in ERC8183 ──────────────────
        if (erc8183Proxy != address(0)) {
            IERC8183Init(erc8183Proxy).setHookWhitelist(address(hook), true);
            IERC8183Init(erc8183Proxy).setPaymentTokenAllowlist(usdc, true);
        }

        vm.stopBroadcast();

        console.log("BondHook deployed:", address(hook));
        console.log("ERC8183 proxy:    ", erc8183Proxy);
        console.log("USDC:             ", usdc);
        console.log("Treasury:         ", treasury);
        console.log("Oracle (deployer):", deployer);
    }
}
