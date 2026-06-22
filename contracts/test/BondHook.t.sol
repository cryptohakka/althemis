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

    // Extended setter for challenge tests: sets hook, status, and time fields.
    function setJobFull(
        uint256 jobId, address client, address provider, uint256 budget,
        address hookAddr, IERC8183Core.JobStatus status,
        uint48 expiredAt, uint48 submittedAt
    ) external {
        IERC8183Core.Job memory j;
        j.client      = client;
        j.provider    = provider;
        j.budget      = budget;
        j.hook        = hookAddr;
        j.status      = status;
        j.expiredAt   = expiredAt;
        j.submittedAt = submittedAt;
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

    // Effective bond rates (basis points) at the two extremes of the
    // reliability × skill product. These are derived offchain by tier.ts
    // and pushed via setProviderBondRate; this test asserts the on-chain
    // math at each end of the legal range.
    //   Bronze × Calibrated  = 20000 (200%, default)
    //   Gold   x Edge-G      = 13750 x 8000 / 10000 = 11000 (110%, floor)
    uint256 constant BRONZE_BPS = 20000;
    uint256 constant MIN_BPS    = 11000;

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

    function _setRate(uint256 bps) internal {
        vm.prank(oracle);
        hook.setProviderBondRate(provider, bps);
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

    function test_AfterFund_LocksDefaultBronzeRate() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        // Default (no rate set) = Bronze = 200% of budget
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

    /// @dev New-provider invariant: while count < NEW_PROVIDER_JOB_CAP a provider
    ///      is capped on per-job budget only, never on the number of jobs. The
    ///      provider keeps taking (budget-capped) jobs and graduates at the cap.
    function test_NewProvider_BudgetCappedNotCountCapped() public {
        _deposit(100 * USDC_1);
        for (uint256 i = 1; i <= 15; i++) {
            _completeJob(i, USDC_1); // 11th–15th jobs are NOT blocked by a count cap
        }
        assertEq(hook.providerJobCount(provider), 15);
    }

    // ══════════════════════════════════════════════════════════
    // 3. Bond rate — oracle control + lock amounts + floor invariant
    // ══════════════════════════════════════════════════════════

    function test_DefaultBondRate_IsBronze() public {
        // No rate set → getBondRate returns DEFAULT_BOND_RATE_BPS
        assertEq(hook.getBondRate(provider), BRONZE_BPS);
        assertEq(hook.providerBondRateBps(provider), 0); // mapping unset
    }

    function test_SetBondRate_Silver() public {
        _setRate(16000); // Silver = 160%
        assertEq(hook.getBondRate(provider), 16000);
        assertEq(hook.providerBondRateBps(provider), 16000);
    }

    function test_SetBondRate_Gold() public {
        _setRate(12500); // Gold = 125%
        assertEq(hook.getBondRate(provider), 12500);
    }

    function test_SetBondRate_GoldEdgeG_HitsFloor() public {
        // Math floor of the offchain product: Gold × Edge-G = 12500 × 0.80 = 10000
        _setRate(MIN_BPS);
        assertEq(hook.getBondRate(provider), MIN_BPS);
    }

    function test_SetBondRate_RevertsBelowFloor() public {
        // 9999 bps (99.99%) breaks the slash≥budget invariant → must revert
        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(BondHook.BondRateBelowFloor.selector, 9999, MIN_BPS)
        );
        hook.setProviderBondRate(provider, 9999);

        // Zero is also below floor — defends against accidental "reset to 0"
        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(BondHook.BondRateBelowFloor.selector, 0, MIN_BPS)
        );
        hook.setProviderBondRate(provider, 0);
    }

    function test_SetBondRate_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit BondHook.BondRateUpdated(provider, 16000);
        _setRate(16000);
    }

    function test_SetBondRate_RevertsForNonOracle() public {
        vm.prank(rando);
        vm.expectRevert(); // AccessControlUnauthorizedAccount
        hook.setProviderBondRate(provider, 12500);
    }

    function test_LowerRate_LocksLowerBond() public {
        // Push provider to the math floor (Gold × Edge-G), then graduate past
        // the new-provider budget cap so we can fund a larger job.
        _setRate(MIN_BPS); // 11000 bps = 110%

        _deposit(100 * USDC_1);
        for (uint256 i = 1; i <= 10; i++) {
            _completeJob(i, USDC_1); // locks 1 USDC at 100% rate
        }

        _fundJob(11, 5 * USDC_1);
        assertEq(hook.jobBondLocked(11), (5 * USDC_1 * MIN_BPS) / 10000); // 110% of 5 USDC = 5.5
    }

    /// @dev Rate changes only affect NEW locks. Job 1 locked at Bronze (200%)
    ///      must keep its 2-USDC lock even after the provider is upgraded.
    function test_RateChange_DoesNotAffectExistingLock() public {
        _deposit(4 * USDC_1);
        _fundJob(1, USDC_1); // locks 2 USDC at default Bronze

        _setRate(MIN_BPS); // promote to floor (110%)

        assertEq(hook.jobBondLocked(1), 2 * USDC_1); // unchanged
        assertEq(hook.bondLocked(provider), 2 * USDC_1);

        _fundJob(2, USDC_1); // new lock at new rate
        assertEq(hook.jobBondLocked(2), (USDC_1 * MIN_BPS) / 10000); // 110% of 1 USDC = 1.1
    }

    // ══════════════════════════════════════════════════════════
    // 4. Slash — 80/20 split, balances, events
    // ══════════════════════════════════════════════════════════

    function test_Slash_ConsumerFull_TreasuryRemainder() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1); // locks 2 USDC

        uint256 lockAmt = 2 * USDC_1;
        vm.expectEmit(true, true, false, true);
        emit BondHook.BondSlashed(1, provider, lockAmt, consumer, treasury);

        core.driveAfterReject(1, hook.SLASH_REASON());

        // budget = 1 USDC, lockAmt = 2 USDC (Bronze 200%).
        // consumer = budget (100%), treasury = lockAmt - budget, challenger = 0.
        assertEq(usdc.balanceOf(consumer), USDC_1);            // 1.0 USDC (full price)
        assertEq(usdc.balanceOf(treasury), lockAmt - USDC_1);  // 1.0 USDC (remainder)
        assertEq(hook.bondBalance(provider), 0);
        assertEq(hook.bondLocked(provider), 0);
        assertEq(hook.jobBondLocked(1), 0);
        assertEq(hook.providerJobCount(provider), 1); // reject also counts
    }

    /// @dev Floor invariant: at the minimum allowed rate, slash still meets the
    ///      job budget exactly. Consumer gets 100% of budget, treasury = remainder.
    function test_Slash_AtFloor_StillCoversBudget() public {
        _setRate(MIN_BPS);            // 11000 bps = 110%
        _deposit((USDC_1 * MIN_BPS) / 10000); // deposit exactly the 1.1 USDC lock
        _fundJob(1, USDC_1);          // budget 1 USDC, locks 1.1 USDC at 110%
        uint256 lockAmt = (USDC_1 * MIN_BPS) / 10000; // 1.1 USDC
        core.driveAfterReject(1, hook.SLASH_REASON());
        // consumer = budget (100%), treasury = lockAmt - budget (10%), challenger = 0
        assertEq(usdc.balanceOf(consumer), USDC_1);
        assertEq(usdc.balanceOf(treasury), lockAmt - USDC_1);
        assertEq(hook.bondBalance(provider), 0);
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

    /// @dev Defense-in-depth: the deployed ERC-8183 core gates complete()/reject()
    ///      on JobStatus.Submitted and flips to a terminal status before firing the
    ///      after-hook, so a job's terminal hook fires at most once via the real core.
    ///      BondHook does not trust that: the jobCounted guard makes providerJobCount
    ///      idempotent even if a mis-behaving core re-fires the hook.
    function test_DoubleComplete_CountedOnce() public {
        _deposit(2 * USDC_1);
        _fundJob(1, USDC_1);

        core.driveAfterComplete(1);
        core.driveAfterComplete(1); // simulated core misbehavior

        assertEq(hook.bondLocked(provider), 0);          // unlock is idempotent
        assertEq(hook.providerJobCount(provider), 1);    // count is now idempotent too
        assertTrue(hook.jobCounted(1));
    }

    // ══════════════════════════════════════════════════════════
    // 7. Permissionless deterministic challenge
    // ══════════════════════════════════════════════════════════

    /// Helper: fund a job (locks bond), then overwrite core state to `expired`.
    function _fundThenExpire(uint256 jobId, uint256 budget) internal {
        vm.warp(1_000_000);      // advance clock so expiredAt can be a real past value
        _deposit(4 * USDC_1);
        _fundJob(jobId, budget); // locks bond at Bronze 200%
        // Overwrite core job: same provider/client/budget, but expired + our hook.
        core.setJobFull(
            jobId, consumer, provider, budget,
            address(hook), IERC8183Core.JobStatus.Submitted,
            uint48(block.timestamp - 100), uint48(0) // expiredAt in the past
        );
    }

    function _arm(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(hook), amount);
    }

    function test_Challenge_ExpiredSquatter_Slashes() public {
        _fundThenExpire(1, USDC_1);          // budget 1, lock 2 USDC (Bronze)
        uint256 stake = USDC_1 / 10;         // price/10 = 0.1
        _arm(rando, stake);

        uint256 lockAmt = hook.jobBondLocked(1);
        vm.prank(rando);
        hook.challenge(1);

        // consumer 100% of price, challenger 10% of price, treasury remainder, stake returned
        assertEq(usdc.balanceOf(consumer), USDC_1);                 // full price
        assertEq(usdc.balanceOf(rando), (USDC_1/10) + stake);       // 10% reward + stake returned = 0.2
        assertEq(usdc.balanceOf(treasury), lockAmt - USDC_1 - (USDC_1/10)); // remainder
        assertEq(hook.jobBondLocked(1), 0);
    }

    function test_Challenge_PostExpirySubmit_Slashes() public {
        _deposit(4 * USDC_1);
        _fundJob(2, USDC_1);
        // submittedAt > expiredAt (post-expiry submission), status Submitted, not yet time-expired
        core.setJobFull(
            2, consumer, provider, USDC_1,
            address(hook), IERC8183Core.JobStatus.Submitted,
            uint48(block.timestamp + 1000), uint48(block.timestamp + 2000)
        );
        uint256 stake = USDC_1 / 10;
        _arm(rando, stake);

        vm.prank(rando);
        hook.challenge(2);
        assertEq(usdc.balanceOf(consumer), USDC_1);
        assertEq(hook.jobBondLocked(2), 0);
    }

    function test_Challenge_ValidJob_Reverts_StakeForfeited() public {
        _deposit(4 * USDC_1);
        _fundJob(3, USDC_1);
        // Valid job: not expired, submittedAt <= expiredAt, our hook.
        core.setJobFull(
            3, consumer, provider, USDC_1,
            address(hook), IERC8183Core.JobStatus.Submitted,
            uint48(block.timestamp + 1000), uint48(block.timestamp + 500)
        );
        uint256 stake = USDC_1 / 10;
        _arm(rando, stake);

        vm.prank(rando);
        hook.challenge(3); // false challenge: does NOT revert, forfeits stake

        assertEq(usdc.balanceOf(treasury), stake);   // stake forfeited to treasury
        assertEq(usdc.balanceOf(rando), 0);           // challenger lost stake
        assertEq(hook.jobBondLocked(3), USDC_1 * 2);  // job untouched (still locked)
    }

    function test_Challenge_Settled_Reverts() public {
        _deposit(4 * USDC_1);
        _completeJob(4, USDC_1); // funds then completes -> bond unlocked, jobBondLocked = 0
        uint256 stake = USDC_1 / 10;
        _arm(rando, stake);

        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(BondHook.NotChallengeable.selector, uint256(4)));
        hook.challenge(4);
    }

    function test_Challenge_WrongHook_Reverts() public {
        _deposit(4 * USDC_1);
        _fundJob(5, USDC_1);
        // Overwrite with a DIFFERENT hook address -> not our job.
        core.setJobFull(
            5, consumer, provider, USDC_1,
            address(0xBEEF), IERC8183Core.JobStatus.Submitted,
            uint48(block.timestamp - 1), uint48(0)
        );
        uint256 stake = USDC_1 / 10;
        _arm(rando, stake);

        vm.prank(rando);
        vm.expectRevert(abi.encodeWithSelector(BondHook.NotChallengeable.selector, uint256(5)));
        hook.challenge(5);
    }

}