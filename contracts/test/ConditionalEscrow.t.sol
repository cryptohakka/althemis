// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../ConditionalEscrow.sol";
import "../ConditionalPriceFeed.sol";

// Minimal mock USDC (6 decimals like real USDC).
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address sp, uint256 amt) external returns (bool) {
        allowance[msg.sender][sp] = amt; return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt; balanceOf[to] += amt; return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt; balanceOf[to] += amt; return true;
    }
}

contract ConditionalEscrowTest is Test {
    ConditionalEscrow escrow;
    ConditionalPriceFeed feed;
    MockUSDC usdc;

    address admin    = address(0xA11CE);
    address oracle   = address(0x07AC1E);
    address consumer = address(0xC0FFEE);

    // Provider must be derived from a known private key so we can sign.
    uint256 providerPk = 0xBEEF;
    address provider;

    uint256 constant BOND    = 5e5; // 0.5 USDC payout if condition misses
    uint256 constant PREMIUM = 5e4; // 0.05 USDC cost of the claim
    uint8   constant ASSET   = 0;   // ASSET_BTC

    function setUp() public {
        provider = vm.addr(providerPk);

        usdc = new MockUSDC();
        feed = new ConditionalPriceFeed(admin, oracle);
        escrow = new ConditionalEscrow(address(usdc), address(feed));

        // Both sides are funded and approve the escrow.
        usdc.mint(provider, 1e7);
        usdc.mint(consumer, 1e7);
        vm.prank(provider);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(consumer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // Sign a declaration as the provider (EIP-191 personal_sign).
    function _sign(uint8 window, ConditionalEscrow.Op op, int256 expected)
        internal view returns (bytes memory)
    {
        bytes32 dh = escrow.declarationHash(ASSET, window, op, expected);
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(providerPk, eth);
        return abi.encodePacked(r, s, v);
    }

    // Provider declares + bonds. Provider is msg.sender.
    function _declare(bytes32 jobId, uint8 window, ConditionalEscrow.Op op, int256 expected)
        internal
    {
        bytes memory sig = _sign(window, op, expected);
        vm.prank(provider);
        escrow.declare(jobId, ASSET, window, op, expected, BOND, PREMIUM, sig);
    }

    // Consumer buys the claim by paying the premium.
    function _purchase(bytes32 jobId) internal {
        vm.prank(consumer);
        escrow.purchase(jobId);
    }

    // Declare + purchase in one helper for settlement tests.
    function _open(bytes32 jobId, uint8 window, ConditionalEscrow.Op op, int256 expected) internal {
        _declare(jobId, window, op, expected);
        _purchase(jobId);
    }

    // Post the realized feed value for a job's settlement key.
    // jobs() tuple: provider, consumer, bond, premium, asset, window, op, expected, deadline, status
    function _postRealized(bytes32 jobId, int256 realized) internal {
        (, , , , uint8 asset, uint8 window, , , uint64 deadline, ) = escrow.jobs(jobId);
        bytes32 key = feed.deriveKey(asset, window, deadline);
        vm.prank(oracle);
        feed.postValue(key, realized);
    }

    function _status(bytes32 jobId) internal view returns (ConditionalEscrow.Status) {
        (, , , , , , , , , ConditionalEscrow.Status st) = escrow.jobs(jobId);
        return st;
    }

    // ── 1. met (LTE): provider keeps premium + recovers bond ────
    function test_Met_LTE_providerKeepsPremiumAndBond() public {
        bytes32 jobId = keccak256("job1");
        uint256 provBefore = usdc.balanceOf(provider); // already paid BOND in declare
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0); // "FR <= 0 after 8h"
        // after declare(BOND) + purchase: provider is down BOND, consumer down PREMIUM
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, -5); // -5 <= 0 -> met
        escrow.settle(jobId);

        // provider regains bond and gains premium => net +PREMIUM vs start
        assertEq(usdc.balanceOf(provider), provBefore + PREMIUM, "provider net +premium");
        assertEq(uint8(_status(jobId)), uint8(ConditionalEscrow.Status.Released));
    }

    // ── 2. missed (LTE): consumer gets bond, provider keeps premium ─
    function test_Missed_LTE_consumerGetsBond() public {
        bytes32 jobId = keccak256("job2");
        uint256 provBefore = usdc.balanceOf(provider);
        uint256 consBefore = usdc.balanceOf(consumer);
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, 5); // 5 <= 0 false -> missed
        escrow.settle(jobId);

        // consumer paid PREMIUM, receives BOND => net (BOND - PREMIUM)
        assertEq(usdc.balanceOf(consumer), consBefore - PREMIUM + BOND, "consumer net +bond-premium");
        // provider paid BOND, keeps PREMIUM => net (PREMIUM - BOND) ... i.e. lost bond, kept premium
        assertEq(usdc.balanceOf(provider), provBefore - BOND + PREMIUM, "provider lost bond, kept premium");
        assertEq(uint8(_status(jobId)), uint8(ConditionalEscrow.Status.PaidOut));
    }

    // ── 3. met (GTE) ────────────────────────────────────────────
    function test_Met_GTE() public {
        bytes32 jobId = keccak256("job3");
        uint256 provBefore = usdc.balanceOf(provider);
        _open(jobId, 16, ConditionalEscrow.Op.GTE, 10);
        vm.warp(block.timestamp + 16 hours + 1);
        _postRealized(jobId, 15); // 15 >= 10 -> met
        escrow.settle(jobId);
        assertEq(usdc.balanceOf(provider), provBefore + PREMIUM);
    }

    // ── 4. no buyer by deadline: provider withdraws full bond ───
    function test_Withdraw_noBuyer_providerRecoversBond() public {
        bytes32 jobId = keccak256("job4");
        uint256 provBefore = usdc.balanceOf(provider);
        _declare(jobId, 8, ConditionalEscrow.Op.LTE, 0); // declared, never purchased
        assertEq(usdc.balanceOf(provider), provBefore - BOND, "bond locked");
        vm.warp(block.timestamp + 8 hours + 1);
        vm.prank(provider);
        escrow.withdraw(jobId);
        assertEq(usdc.balanceOf(provider), provBefore, "bond fully recovered");
        assertEq(uint8(_status(jobId)), uint8(ConditionalEscrow.Status.Withdrawn));
    }

    // ── 5. withdraw before deadline reverts ─────────────────────
    function test_Withdraw_beforeDeadline_reverts() public {
        bytes32 jobId = keccak256("job5");
        _declare(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.BeforeDeadline.selector, jobId));
        vm.prank(provider);
        escrow.withdraw(jobId);
    }

    // ── 6. withdraw on a purchased job reverts (not Declared) ───
    function test_Withdraw_afterPurchase_reverts() public {
        bytes32 jobId = keccak256("job6");
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.NotDeclared.selector, jobId));
        vm.prank(provider);
        escrow.withdraw(jobId);
    }

    // ── 7. settle before deadline reverts ───────────────────────
    function test_Settle_beforeDeadline_reverts() public {
        bytes32 jobId = keccak256("job7");
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        _postRealized(jobId, -1);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.BeforeDeadline.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 8. settle on un-purchased job reverts (NotPurchased) ────
    function test_Settle_notPurchased_reverts() public {
        bytes32 jobId = keccak256("job8");
        _declare(jobId, 8, ConditionalEscrow.Op.LTE, 0); // declared only
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, -1);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.NotPurchased.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 9. feed not posted -> FeedNotReady (held) ───────────────
    function test_Settle_feedNotReady_reverts() public {
        bytes32 jobId = keccak256("job9");
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.FeedNotReady.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 10. wrong signer rejected at declare ────────────────────
    function test_Declare_badSignature_wrongSigner() public {
        bytes32 jobId = keccak256("job10");
        bytes32 dh = escrow.declarationHash(ASSET, 8, ConditionalEscrow.Op.LTE, 0);
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), eth);
        bytes memory badSig = abi.encodePacked(r, s, v);
        vm.prank(provider);
        vm.expectRevert(ConditionalEscrow.BadSignature.selector);
        escrow.declare(jobId, ASSET, 8, ConditionalEscrow.Op.LTE, 0, BOND, PREMIUM, badSig);
    }

    // ── 11. signature over different params rejected ────────────
    function test_Declare_badSignature_paramMismatch() public {
        bytes32 jobId = keccak256("job11");
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0); // signs expected=0
        vm.prank(provider);
        vm.expectRevert(ConditionalEscrow.BadSignature.selector);
        escrow.declare(jobId, ASSET, 8, ConditionalEscrow.Op.LTE, 99, BOND, PREMIUM, sig); // commits 99
    }

    // ── 12. unsupported window / asset rejected ─────────────────
    function test_Declare_unsupportedWindow_reverts() public {
        bytes32 jobId = keccak256("job12");
        bytes memory sig = _sign(1, ConditionalEscrow.Op.LTE, 0);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.UnsupportedWindow.selector, uint8(1)));
        escrow.declare(jobId, ASSET, 1, ConditionalEscrow.Op.LTE, 0, BOND, PREMIUM, sig);
    }

    function test_Declare_unsupportedAsset_reverts() public {
        bytes32 jobId = keccak256("job13");
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.UnsupportedAsset.selector, uint8(2)));
        escrow.declare(jobId, 2, 8, ConditionalEscrow.Op.LTE, 0, BOND, PREMIUM, sig);
    }

    // ── 13. zero bond rejected ──────────────────────────────────
    function test_Declare_zeroBond_reverts() public {
        bytes32 jobId = keccak256("job14");
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(provider);
        vm.expectRevert(ConditionalEscrow.ZeroBond.selector);
        escrow.declare(jobId, ASSET, 8, ConditionalEscrow.Op.LTE, 0, 0, PREMIUM, sig);
    }

    // ── 14. duplicate declare rejected ──────────────────────────
    function test_Declare_duplicate_reverts() public {
        bytes32 jobId = keccak256("job15");
        _declare(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.JobExists.selector, jobId));
        escrow.declare(jobId, ASSET, 8, ConditionalEscrow.Op.LTE, 0, BOND, PREMIUM, sig);
    }

    // ── 15. double purchase rejected ────────────────────────────
    function test_Purchase_twice_reverts() public {
        bytes32 jobId = keccak256("job16");
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.AlreadyPurchased.selector, jobId));
        escrow.purchase(jobId);
    }

    // ── 16. purchase of undeclared job rejected ─────────────────
    function test_Purchase_notDeclared_reverts() public {
        bytes32 jobId = keccak256("job17");
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.NotDeclared.selector, jobId));
        escrow.purchase(jobId);
    }

    // ── 17. double settle rejected ──────────────────────────────
    function test_Settle_twice_reverts() public {
        bytes32 jobId = keccak256("job18");
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, -1);
        escrow.settle(jobId);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.NotPurchased.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 18. boundary: LTE at exact threshold (inclusive -> met) ─
    function test_Met_LTE_atBoundary() public {
        bytes32 jobId = keccak256("job19");
        uint256 provBefore = usdc.balanceOf(provider);
        _open(jobId, 8, ConditionalEscrow.Op.LTE, 7);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, 7); // 7 <= 7 inclusive -> met
        escrow.settle(jobId);
        assertEq(usdc.balanceOf(provider), provBefore + PREMIUM, "boundary inclusive -> met");
    }
}
