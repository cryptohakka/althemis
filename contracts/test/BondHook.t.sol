// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../BondHook.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ──────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @dev Minimal ERC-8183 core stand-in. Holds Job structs and drives the
///      hook callbacks so that msg.sender == core (which holds ACP_ROLE),
///      matching how BondHook reads getJob(jobId) from msg.sender.
contract MockCore {
    BondHook public hook;
    mapping(uint256 => IERC8183Core.Job) internal jobs;

    function setHook(BondHook _hook) external { hook = _hook; }

    function setJob(uint256 jobId, address client, address provider, uint256 budget) external {
        IERC8183Core.Job memory j;
        j.client   = client;
        j.provider = provider;
        j.budget   = budget;
        jobs[jobId] = j;
    }

    function getJob(uint256 jobId) external view returns (IERC8183Core.Job memory) {
        return jobs[jobId];
    }

    // ── drivers (msg.sender = this core) ──
    function driveBeforeFund(uint256 jobId) external {
        hook.beforeAction(jobId, hook.FUND_SELECTOR(), "");
    }
    function driveAfterFund(uint256 jobId) external {
        hook.afterAction(jobId, hook.FUND_SELECTOR(), "");
    }
    function driveAfterComplete(uint256 jobId) external {
        hook.afterAction(jobId, hook.COMPLETE_SELECTOR(), "");
    }
    function driveAfterReject(uint256 jobId, bytes32 reason) external {
        hook.afterAction(jobId, hook.REJECT_SELECTOR(), abi.encode(address(this), reason, bytes("")));
    }
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

contract BondHookTest is Test {
    MockUSDC usdc;
    MockCore core;
    BondHook hook;

    address treasury = makeAddr("treasury");
    address oracle   = makeAddr("oracle");
    address provider = makeAddr("provider");
    address consumer = makeAddr("consumer");
    address rando    = makeAddr("rando");

    uint256 constant USDC_1 = 1_000_000; // 1 USDC, 6 decimals

    function setUp() public {
        usdc = new MockUSDC();
        core = new MockCore();
        hook = new BondHook(address(usdc), treasury, oracle, address(core));
        core.setHook(hook);

        usdc.mint(provider, 1_000 * USDC_1);
        vm.prank(provider);
        usdc.approve(address(hook), type(uint256).max);
    }

    // ── helpers ────────────────────────────────────────────────

    function _deposit(uint256 amount) internal {
        vm.prank(provider);
        hook.deposit(amount);
    }

    /// Full fund flow for one job: setJob → beforeFund → afterFund
    function _fundJob(uint256 jobId, uint256 budget) internal {
        core.setJob(jobId, consumer, provider, budget);
        core.driveBeforeFund(jobId);
        core.driveAfterFund(jobId);
    }

    /// Drive a job through fund + complete (used to graduate the provider)
    function _completeJob(uint256 jobId, uint256 budget) internal {
        _fundJob(jobId, budget);
        core.driveAfterComplete(jobId);
    }

    // ══════════════════════════════════════════════════════════
    // 1. Bond deposit / withdraw / lock / unlock
    // ══════════════════════════════════════════════════════════

    function test_DepositIncreasesBalance() public {
        _deposit(10 * USDC_1);
        assertEq(hook.bondBalance(provider), 10 * USDC_1);
        assertEq(hook.freeBalance(provider), 10 * USDC_1);
        assertEq(usdc.balanceOf(address(hook)), 10 * USDC_1);
    }

    function test_WithdrawFreeBalance() public {
        _deposit(10 * USDC_1);
        vm.prank(provider);
        hook.withdraw(4 * USDC_1);
        assertEq(hook.bondBalance(provider), 6 * USDC_1);
        assertEq(usdc.balanceOf(provider), (1_000 - 6) * USDC_1);
    }

    function test_Withdraw_RevertsWhenLocked() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1); // Bronze 200% → locks 2 USDC

        assertEq(hook.freeBalance(provider), 0);
        vm.prank(provider);
        vm.expectRevert(
            abi.encodeWithSelector(BondHook.InsufficientFreeBalance.selector, USDC_1, 0)
        );
        hook.withdraw(USDC_1);
    }

    function test_AfterFund_LocksBronzeRate() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        // Bronze = 200% of budget
        assertEq(hook.jobBondLocked(1), 2 * USDC_1);
        assertEq(hook.bondLocked(provider), 2 * USDC_1);
        assertEq(hook.jobProvider(1), provider);
        assertEq(hook.jobClient(1), consumer);
    }

    function test_AfterComplete_UnlocksAndCounts() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);
        core.driveAfterComplete(1);

        assertEq(hook.bondLocked(provider), 0);
        assertEq(hook.jobBondLocked(1), 0);
        assertEq(hook.freeBalance(provider), 2 * USDC_1); // bond returns to free
        assertEq(hook.providerJobCount(provider), 1);
        // No transfer on unlock — funds stay in the hook
        assertEq(hook.bondBalance(provider), 2 * USDC_1);
    }

    // ══════════════════════════════════════════════════════════
    // 2. beforeFund — coverage check & new-provider caps
    // ══════════════════════════════════════════════════════════

    function test_BeforeFund_RevertsOnInsufficientBond() public {
        _deposit(USDC_1); // 1 USDC free, Bronze needs 2 for a 1 USDC job
        core.setJob(1, consumer, provider, USDC_1);

        vm.expectRevert(
            abi.encodeWithSelector(BondHook.InsufficientBond.selector, 2 * USDC_1, USDC_1)
        );
        core.driveBeforeFund(1);
    }

    function test_BeforeFund_NewProviderBudgetCap() public {
        _deposit(100 * USDC_1); // plenty of bond — cap must trigger first
        core.setJob(1, consumer, provider, 2 * USDC_1); // > 1 USDC cap

        vm.expectRevert(
            abi.encodeWithSelector(
                BondHook.NewProviderBudgetExceeded.selector, 2 * USDC_1, USDC_1
            )
        );
        core.driveBeforeFund(1);
    }

    function test_BeforeFund_BudgetCapLiftedAfterGraduation() public {
        _deposit(100 * USDC_1);

        // Complete 10 jobs at the capped budget
        for (uint256 i = 1; i <= 10; i++) {
            _completeJob(i, USDC_1);
        }
        assertEq(hook.providerJobCount(provider), 10);

        // Job 11 with 5 USDC budget now passes (Bronze needs 10 USDC bond)
        _fundJob(11, 5 * USDC_1);
        assertEq(hook.jobBondLocked(11), 10 * USDC_1);
    }

    /// @dev Documents the dead-code finding: the inner
    ///      `if (count >= NEW_PROVIDER_JOB_CAP) revert NewProviderJobCapExceeded`
    ///      sits inside `if (count < NEW_PROVIDER_JOB_CAP)` and can never fire.
    ///      Current behavior = "first 10 jobs are budget-capped, never job-capped".
    ///      If the intended design is a hard stop at 10 jobs pending review,
    ///      this test will start failing once that is implemented — update it then.
    function test_Documents_JobCapIsUnreachable() public {
        _deposit(100 * USDC_1);
        for (uint256 i = 1; i <= 15; i++) {
            _completeJob(i, USDC_1); // 11th–15th jobs are NOT blocked
        }
        assertEq(hook.providerJobCount(provider), 15);
    }

    // ══════════════════════════════════════════════════════════
    // 3. Tier rates — oracle control + lock amounts
    // ══════════════════════════════════════════════════════════

    function test_TierRates() public {
        assertEq(hook.getBondRate(provider), 200); // default Bronze

        vm.prank(oracle);
        hook.setProviderTier(provider, BondHook.Tier.Silver);
        assertEq(hook.getBondRate(provider), 150);

        vm.prank(oracle);
        hook.setProviderTier(provider, BondHook.Tier.Gold);
        assertEq(hook.getBondRate(provider), 100);
    }

    function test_SetTier_RevertsForNonOracle() public {
        vm.prank(rando);
        vm.expectRevert(); // AccessControlUnauthorizedAccount
        hook.setProviderTier(provider, BondHook.Tier.Gold);
    }

    function test_GoldTier_LocksLowerBond() public {
        vm.prank(oracle);
        hook.setProviderTier(provider, BondHook.Tier.Gold);

        // Graduate past the new-provider cap first so budget isn't limited
        _deposit(100 * USDC_1);
        for (uint256 i = 1; i <= 10; i++) {
            _completeJob(i, USDC_1);
        }

        _fundJob(11, 5 * USDC_1);
        assertEq(hook.jobBondLocked(11), 5 * USDC_1); // Gold = 100%
    }

    // ══════════════════════════════════════════════════════════
    // 4. Slash — 80/20 split, balances, events
    // ══════════════════════════════════════════════════════════

    function test_Slash_Splits80Consumer20Treasury() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1); // locks 2 USDC

        uint256 lockAmt = 2 * USDC_1;
        vm.expectEmit(true, true, false, true);
        emit BondHook.BondSlashed(1, provider, lockAmt, consumer, treasury);

        core.driveAfterReject(1, hook.SLASH_REASON());

        assertEq(usdc.balanceOf(consumer), (lockAmt * 80) / 100); // 1.6 USDC
        assertEq(usdc.balanceOf(treasury), (lockAmt * 20) / 100); // 0.4 USDC
        assertEq(hook.bondBalance(provider), 0);
        assertEq(hook.bondLocked(provider), 0);
        assertEq(hook.jobBondLocked(1), 0);
        assertEq(hook.providerJobCount(provider), 1); // reject also counts
    }

    function test_Slash_OnlyAffectsThatJobsLock() public {
        _deposit(4 * USDC_1);
        _fundJob(1, USDC_1);
        _fundJob(2, USDC_1);

        core.driveAfterReject(1, hook.SLASH_REASON());

        // Job 2's lock survives; provider keeps the rest of their bond
        assertEq(hook.bondBalance(provider), 2 * USDC_1);
        assertEq(hook.bondLocked(provider), 2 * USDC_1);
        assertEq(hook.jobBondLocked(2), 2 * USDC_1);
        assertEq(hook.freeBalance(provider), 0);
    }

    function test_Reject_WithoutSlashReason_JustUnlocks() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        core.driveAfterReject(1, keccak256("SOME_OTHER_REASON"));

        // No transfers, bond fully unlocked
        assertEq(usdc.balanceOf(consumer), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(hook.bondBalance(provider), 2 * USDC_1);
        assertEq(hook.bondLocked(provider), 0);
        assertEq(hook.providerJobCount(provider), 1);
    }

    function test_Slash_NeutralSettleReason_DoesNotSlash() public {
        // Oracle settles unverifiable jobs via reject with a SETTLE: reason —
        // anything other than the exact SLASH_REASON sentinel must not slash.
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        core.driveAfterReject(1, keccak256("SETTLE:unverifiable:FR_BTC_8h=-0.00000279"));

        assertEq(hook.bondBalance(provider), 2 * USDC_1);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    // ══════════════════════════════════════════════════════════
    // 5. Access control — hooks are ACP-only
    // ══════════════════════════════════════════════════════════

    function test_Hooks_RevertForNonACP() public {
        // Cache selectors before prank — vm.expectRevert consumes the very
        // next call, so any staticcall inside the pranked context (like
        // hook.FUND_SELECTOR()) would be consumed instead of beforeAction.
        bytes4 fundSel     = hook.FUND_SELECTOR();
        bytes4 completeSel = hook.COMPLETE_SELECTOR();

        vm.startPrank(rando);
        vm.expectRevert(BondHook.OnlyACP.selector);
        hook.beforeAction(1, fundSel, "");

        vm.expectRevert(BondHook.OnlyACP.selector);
        hook.afterAction(1, completeSel, "");
        vm.stopPrank();
    }

    function test_SetTreasury_AdminOnly() public {
        vm.prank(rando);
        vm.expectRevert();
        hook.setTreasury(rando);

        hook.setTreasury(rando); // test contract is admin (deployer)
        assertEq(hook.treasury(), rando);
    }

    // ══════════════════════════════════════════════════════════
    // 6. Documented assumption — core must not double-settle
    // ══════════════════════════════════════════════════════════

    /// @dev BondHook assumes the ERC-8183 core never fires complete/reject
    ///      twice for the same job. _unlockBond is idempotent (early return),
    ///      but providerJobCount would double-increment. This test documents
    ///      the current behavior so a future guard changes it consciously.
    function test_Documents_DoubleCompleteDoubleCounts() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        core.driveAfterComplete(1);
        core.driveAfterComplete(1); // hypothetical core misbehavior

        assertEq(hook.bondLocked(provider), 0);          // safe: unlock is idempotent
        assertEq(hook.providerJobCount(provider), 2);    // known: count inflates
    }
}
