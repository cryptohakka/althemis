// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

// ──────────────────────────────────────────────────────────────
// Minimal interface to read job data from ERC8183 core
// ──────────────────────────────────────────────────────────────
interface IERC8183Hook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

interface IERC8183Core {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        address client;
        JobStatus status;
        address provider;
        uint48 expiredAt;
        address evaluator;
        uint48 submittedAt;
        uint256 budget;
        address hook;
        address paymentToken;
        uint256 providerAgentId;
        string description;
    }
    function getJob(uint256 jobId) external view returns (Job memory);
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external;
}

// ──────────────────────────────────────────────────────────────
// BondHook — Althemis bond management for ERC-8183
//
// Bond rate is stored per provider as basis points (1 bp = 0.01%).
// The oracle pushes the effective rate after recomputing reliability ×
// skill discount offchain. This contract enforces only one invariant
// about the rate: it must be ≥ MIN_BOND_RATE_BPS = 10000 (100%). That
// guarantees slash ≥ budget, so fabrication cannot be profitable.
//
// Reliability tier (deterministic, Phase A verified count):
//   Bronze  ( 0– 9 verified) → 20000 bps (200%)
//   Silver  (10–49 verified) → 16000 bps (160%)
//   Gold    (50+   verified) → 12500 bps (125%)
//
// Skill tier (probabilistic, Wilson 95% lower bound on Phase B win rate):
//   Calibrated / Unrated → ×1.00 (10000/10000)
//   Edge-S               → ×0.90 ( 9000/10000) i.e. 10% discount
//   Edge-G               → ×0.80 ( 8000/10000) i.e. 20% discount
//
// Effective rate = reliabilityBps × skillDiscount / 10000.
// Minimum mathematically reachable: 12500 × 0.80 = 10000 (= MIN floor).
//
// Tier changes affect NEW job locks only. Existing job locks are
// immutable: lockAmt is computed and stored at fund time.
//
// Reset: on Phase A fabrication slash, the oracle calls
// setProviderBondRate with the rate corresponding to verifiedCount=0
// (reliability resets to Bronze). Skill axis is independent.
//
// Slash distribution (v1, dispute filer == consumer): 80% consumer,
// 20% treasury. v2 will move to 60/20/20 with a permissionless filer
// (implemented in Veriton; integration tracked separately).
// ──────────────────────────────────────────────────────────────
contract BondHook is IERC8183Hook, ERC165, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant ACP_ROLE    = keccak256("ACP_ROLE");

    // ── Constants ──────────────────────────────────────────────
    // Slash reason sentinel: evaluator passes this to reject() for false attestation
    bytes32 public constant SLASH_REASON = keccak256("ALTHEMIS_FALSE_ATTESTATION");

    // Bond rate denominator and floor (basis points; 10000 = 100%)
    uint256 public constant BPS_DENOMINATOR  = 10000;
    uint256 public constant DEFAULT_BOND_RATE_BPS = 20000; // 200% — new provider
    uint256 public constant MIN_BOND_RATE_BPS     = 10000; // 100% — slash ≥ budget

    // New provider cap: budget-capped per job until graduation
    uint256 public constant NEW_PROVIDER_JOB_CAP    = 10;
    uint256 public constant NEW_PROVIDER_BUDGET_CAP = 1_000_000; // 1 USDC (6 decimals)

    // Function selectors for the ERC8183 ref impl (matches msg.sig in callbacks)
    bytes4 public constant FUND_SELECTOR     = bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 public constant SUBMIT_SELECTOR   = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 public constant COMPLETE_SELECTOR = bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 public constant REJECT_SELECTOR   = bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    // ── State ──────────────────────────────────────────────────
    IERC20 public immutable usdc;
    address public treasury;

    // Provider bond balances
    mapping(address => uint256) public bondBalance; // total deposited
    mapping(address => uint256) public bondLocked;  // sum locked across active jobs

    // Per-job lock (for unlock/slash on settlement)
    mapping(uint256 => uint256) public jobBondLocked; // jobId => locked amount
    mapping(uint256 => address) public jobProvider;   // jobId => provider
    mapping(uint256 => address) public jobClient;     // jobId => client (slash recipient)

    // Effective bond rate per provider (basis points). 0 = unset → DEFAULT.
    mapping(address => uint256) public providerBondRateBps;

    // Provider job counters (for new-provider cap)
    mapping(address => uint256) public providerJobCount;

    // Per-job guard: each job counts toward providerJobCount at most once,
    // regardless of how many times a (mis-behaving) core fires the terminal hook.
    mapping(uint256 => bool) public jobCounted;

    // ── Events ─────────────────────────────────────────────────
    event BondDeposited(address indexed provider, uint256 amount);
    event BondWithdrawn(address indexed provider, uint256 amount);
    event BondLocked(uint256 indexed jobId, address indexed provider, uint256 amount);
    event BondUnlocked(uint256 indexed jobId, address indexed provider, uint256 amount);
    event BondSlashed(
        uint256 indexed jobId, address indexed provider, uint256 amount,
        address consumer, address treasury_
    );
    event BondRateUpdated(address indexed provider, uint256 newRateBps);

    // ── Errors ─────────────────────────────────────────────────
    error OnlyACP();
    error InsufficientBond(uint256 required, uint256 available);
    error NewProviderBudgetExceeded(uint256 budget, uint256 cap);
    error InsufficientFreeBalance(uint256 requested, uint256 free);
    error ZeroAddress();
    error BondRateBelowFloor(uint256 bps, uint256 floor);

    // ── Constructor ────────────────────────────────────────────
    constructor(address _usdc, address _treasury, address _oracle, address _acp) {
        if (_usdc == address(0) || _treasury == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        treasury = _treasury;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ORACLE_ROLE, _oracle);
        _grantRole(ACP_ROLE, _acp); // ERC8183 contract address
    }

    // ── ERC165 ─────────────────────────────────────────────────
    function supportsInterface(bytes4 interfaceId)
        public view override(ERC165, AccessControl) returns (bool)
    {
        return interfaceId == type(IERC8183Hook).interfaceId || super.supportsInterface(interfaceId);
    }

    // ── Bond management ────────────────────────────────────────

    /// @notice Provider deposits USDC as bond collateral
    function deposit(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        bondBalance[msg.sender] += amount;
        emit BondDeposited(msg.sender, amount);
    }

    /// @notice Provider withdraws free (unlocked) bond
    function withdraw(uint256 amount) external nonReentrant {
        uint256 free = bondBalance[msg.sender] - bondLocked[msg.sender];
        if (amount > free) revert InsufficientFreeBalance(amount, free);
        bondBalance[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    /// @notice Free balance available for new job locks
    function freeBalance(address provider) external view returns (uint256) {
        return bondBalance[provider] - bondLocked[provider];
    }

    // ── Tier / rate management (oracle-controlled) ────────────

    /// @notice Oracle pushes the effective bond rate (basis points) for a provider.
    /// @dev rateBps must be >= MIN_BOND_RATE_BPS (100%) — guarantees slash ≥ budget.
    function setProviderBondRate(address provider, uint256 rateBps)
        external onlyRole(ORACLE_ROLE)
    {
        if (rateBps < MIN_BOND_RATE_BPS) revert BondRateBelowFloor(rateBps, MIN_BOND_RATE_BPS);
        providerBondRateBps[provider] = rateBps;
        emit BondRateUpdated(provider, rateBps);
    }

    /// @notice Effective bond rate in basis points (0 mapping → DEFAULT for new providers)
    function getBondRate(address provider) public view returns (uint256) {
        uint256 bps = providerBondRateBps[provider];
        return bps == 0 ? DEFAULT_BOND_RATE_BPS : bps;
    }

    // ── IERC8183Hook ──────────────────────────────────────────

    modifier onlyACP() {
        if (!hasRole(ACP_ROLE, msg.sender)) revert OnlyACP();
        _;
    }

    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external override onlyACP nonReentrant
    {
        if (selector == FUND_SELECTOR) {
            _beforeFund(jobId, data);
        }
        // Other selectors: no-op before
    }

    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data)
        external override onlyACP nonReentrant
    {
        if (selector == FUND_SELECTOR) {
            _afterFund(jobId);
        } else if (selector == COMPLETE_SELECTOR) {
            _afterComplete(jobId);
        } else if (selector == REJECT_SELECTOR) {
            _afterReject(jobId, data);
        }
        // SUBMIT_SELECTOR: no-op after (bond already locked at fund)
    }

    // ── Internal hook handlers ─────────────────────────────────

    /// @dev beforeFund: validate bond coverage and new-provider caps.
    /// data = abi.encode(address client, bytes optParams)  [ref impl encoding]
    function _beforeFund(uint256 jobId, bytes calldata /*data*/) internal {
        IERC8183Core.Job memory job = IERC8183Core(msg.sender).getJob(jobId);
        address provider = job.provider;
        uint256 budget   = job.budget;
        uint256 count    = providerJobCount[provider];

        // New provider (< NEW_PROVIDER_JOB_CAP completed jobs): budget-capped
        // per job, with no cap on the number of concurrent/total jobs. The
        // provider graduates once providerJobCount reaches NEW_PROVIDER_JOB_CAP.
        if (count < NEW_PROVIDER_JOB_CAP) {
            if (budget > NEW_PROVIDER_BUDGET_CAP)
                revert NewProviderBudgetExceeded(budget, NEW_PROVIDER_BUDGET_CAP);
        }

        // Bond coverage: free balance >= rateBps × budget / 10000
        uint256 rateBps  = getBondRate(provider);
        uint256 required = (budget * rateBps) / BPS_DENOMINATOR;
        uint256 free     = bondBalance[provider] - bondLocked[provider];
        if (free < required) revert InsufficientBond(required, free);
    }

    /// @dev afterFund: lock bond for this job at the rate effective NOW.
    /// Subsequent rate changes do not affect this lock.
    function _afterFund(uint256 jobId) internal {
        IERC8183Core.Job memory job = IERC8183Core(msg.sender).getJob(jobId);
        address provider = job.provider;
        uint256 rateBps  = getBondRate(provider);
        uint256 lockAmt  = (job.budget * rateBps) / BPS_DENOMINATOR;

        jobBondLocked[jobId] = lockAmt;
        jobProvider[jobId]   = provider;
        jobClient[jobId]     = job.client;
        bondLocked[provider] += lockAmt;

        emit BondLocked(jobId, provider, lockAmt);
    }

    /// @dev afterComplete: unlock bond, increment job count (for graduation tracking)
    function _afterComplete(uint256 jobId) internal {
        _unlockBond(jobId);
        address provider = jobProvider[jobId];
        if (provider != address(0) && !jobCounted[jobId]) {
            jobCounted[jobId] = true;
            providerJobCount[provider]++;
        }
    }

    /// @dev afterReject: slash if SLASH_REASON, else just unlock.
    /// data = abi.encode(address rejector, bytes32 reason, bytes optParams)
    function _afterReject(uint256 jobId, bytes calldata data) internal {
        (, bytes32 reason,) = abi.decode(data, (address, bytes32, bytes));

        address provider = jobProvider[jobId];
        uint256 lockAmt  = jobBondLocked[jobId];
        address consumer = jobClient[jobId];

        if (reason == SLASH_REASON && lockAmt > 0 && provider != address(0)) {
            // v1: dispute filer == consumer ⇒ consumer gets 80%, treasury 20%.
            // v2 (Veriton-style 60/20/20 with permissionless filer): tracked separately.
            uint256 toConsumer = (lockAmt * 80) / 100;
            uint256 toTreasury = lockAmt - toConsumer;

            bondBalance[provider] -= lockAmt;
            bondLocked[provider]  -= lockAmt;
            delete jobBondLocked[jobId];

            if (toConsumer > 0) usdc.safeTransfer(consumer, toConsumer);
            if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);

            emit BondSlashed(jobId, provider, lockAmt, consumer, treasury);
        } else {
            // No slash: just unlock (normal reject, e.g. prediction miss)
            _unlockBond(jobId);
        }

        // Increment job count on reject too (for graduation), once per job
        if (provider != address(0) && !jobCounted[jobId]) {
            jobCounted[jobId] = true;
            providerJobCount[provider]++;
        }
    }

    /// @dev Unlock bond for a job (no transfer)
    function _unlockBond(uint256 jobId) internal {
        uint256 lockAmt  = jobBondLocked[jobId];
        address provider = jobProvider[jobId];
        if (lockAmt == 0 || provider == address(0)) return;

        bondLocked[provider] -= lockAmt;
        delete jobBondLocked[jobId];

        emit BondUnlocked(jobId, provider, lockAmt);
    }

    // ── Admin ──────────────────────────────────────────────────

    function setTreasury(address _treasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }
}
