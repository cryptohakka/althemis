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

    uint256 constant AMOUNT = 5e4; // 0.05 USDC (6 decimals)
    uint8   constant ASSET  = 0;   // ASSET_BTC

    function setUp() public {
        provider = vm.addr(providerPk);

        usdc = new MockUSDC();
        feed = new ConditionalPriceFeed(admin, oracle);
        escrow = new ConditionalEscrow(address(usdc), address(feed));

        usdc.mint(consumer, 1e6);
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

    function _commit(bytes32 jobId, uint8 window, ConditionalEscrow.Op op, int256 expected)
        internal
    {
        bytes memory sig = _sign(window, op, expected);
        vm.prank(consumer);
        escrow.commit(jobId, provider, ASSET, window, op, expected, AMOUNT, sig);
    }

    // Post the realized feed value for a job's settlement key.
    function _postRealized(bytes32 jobId, int256 realized) internal {
        (, , , uint8 asset, uint8 window, , , uint64 deadline, ) = escrow.jobs(jobId);
        bytes32 key = feed.deriveKey(asset, window, deadline);
        vm.prank(oracle);
        feed.postValue(key, realized);
    }

    // ── 1. release: LTE condition met ───────────────────────────
    function test_Release_LTE_met() public {
        bytes32 jobId = keccak256("job1");
        // "FR <= 0 after 8h"
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, -5); // realized -5 <= 0 -> met -> release
        escrow.settle(jobId);

        assertEq(usdc.balanceOf(provider), AMOUNT, "provider paid on release");
        (, , , , , , , , ConditionalEscrow.Status st) = escrow.jobs(jobId);
        assertEq(uint8(st), uint8(ConditionalEscrow.Status.Released));
    }

    // ── 2. refund: LTE condition NOT met ────────────────────────
    function test_Refund_LTE_notMet() public {
        bytes32 jobId = keccak256("job2");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, 5); // 5 <= 0 false -> refund

        uint256 before = usdc.balanceOf(consumer);
        escrow.settle(jobId);

        assertEq(usdc.balanceOf(consumer), before + AMOUNT, "consumer refunded");
        assertEq(usdc.balanceOf(provider), 0, "provider not paid");
        (, , , , , , , , ConditionalEscrow.Status st) = escrow.jobs(jobId);
        assertEq(uint8(st), uint8(ConditionalEscrow.Status.Refunded));
    }

    // ── 3. release: GTE condition met ───────────────────────────
    function test_Release_GTE_met() public {
        bytes32 jobId = keccak256("job3");
        _commit(jobId, 16, ConditionalEscrow.Op.GTE, 10);
        vm.warp(block.timestamp + 16 hours + 1);
        _postRealized(jobId, 15); // 15 >= 10 -> met
        escrow.settle(jobId);
        assertEq(usdc.balanceOf(provider), AMOUNT);
    }

    // ── 4. settle before deadline reverts ───────────────────────
    function test_Settle_beforeDeadline_reverts() public {
        bytes32 jobId = keccak256("job4");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        _postRealized(jobId, -1);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.BeforeDeadline.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 5. feed not posted -> FeedNotReady (held, never defaults) ─
    function test_Settle_feedNotReady_reverts() public {
        bytes32 jobId = keccak256("job5");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        // no postValue
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.FeedNotReady.selector, jobId));
        escrow.settle(jobId);
        // funds still in escrow, no payout happened
        assertEq(usdc.balanceOf(provider), 0);
    }

    // ── 6a. wrong signer rejected ───────────────────────────────
    function test_Commit_badSignature_wrongSigner() public {
        bytes32 jobId = keccak256("job6");
        // sign with a different key than `provider`
        bytes32 dh = escrow.declarationHash(ASSET, 8, ConditionalEscrow.Op.LTE, 0);
        bytes32 eth = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(uint256(0xDEAD), eth);
        bytes memory badSig = abi.encodePacked(r, s, v);
        vm.prank(consumer);
        vm.expectRevert(ConditionalEscrow.BadSignature.selector);
        escrow.commit(jobId, provider, ASSET, 8, ConditionalEscrow.Op.LTE, 0, AMOUNT, badSig);
    }

    // ── 6b. signature over different params rejected (no craft) ──
    function test_Commit_badSignature_paramMismatch() public {
        bytes32 jobId = keccak256("job7");
        // provider signs expected=0, but consumer tries to commit expected=99
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(consumer);
        vm.expectRevert(ConditionalEscrow.BadSignature.selector);
        escrow.commit(jobId, provider, ASSET, 8, ConditionalEscrow.Op.LTE, 99, AMOUNT, sig);
    }

    // ── 7. unsupported window / asset rejected ──────────────────
    function test_Commit_unsupportedWindow_reverts() public {
        bytes32 jobId = keccak256("job8");
        bytes memory sig = _sign(1, ConditionalEscrow.Op.LTE, 0); // 1h not allowed
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.UnsupportedWindow.selector, uint8(1)));
        escrow.commit(jobId, provider, ASSET, 1, ConditionalEscrow.Op.LTE, 0, AMOUNT, sig);
    }

    function test_Commit_unsupportedAsset_reverts() public {
        bytes32 jobId = keccak256("job9");
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.UnsupportedAsset.selector, uint8(2)));
        escrow.commit(jobId, provider, 2, 8, ConditionalEscrow.Op.LTE, 0, AMOUNT, sig);
    }

    // ── 8. double commit / double settle rejected ───────────────
    function test_Commit_duplicate_reverts() public {
        bytes32 jobId = keccak256("job10");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        bytes memory sig = _sign(8, ConditionalEscrow.Op.LTE, 0);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.JobExists.selector, jobId));
        escrow.commit(jobId, provider, ASSET, 8, ConditionalEscrow.Op.LTE, 0, AMOUNT, sig);
    }

    function test_Settle_twice_reverts() public {
        bytes32 jobId = keccak256("job11");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 0);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, -1);
        escrow.settle(jobId);
        vm.expectRevert(abi.encodeWithSelector(ConditionalEscrow.NotOpen.selector, jobId));
        escrow.settle(jobId);
    }

    // ── 9. boundary: GTE/LTE at exact threshold (inclusive) ─────
    function test_Release_LTE_atBoundary() public {
        bytes32 jobId = keccak256("job12");
        _commit(jobId, 8, ConditionalEscrow.Op.LTE, 7);
        vm.warp(block.timestamp + 8 hours + 1);
        _postRealized(jobId, 7); // 7 <= 7 inclusive -> met
        escrow.settle(jobId);
        assertEq(usdc.balanceOf(provider), AMOUNT, "boundary inclusive -> release");
    }
}
