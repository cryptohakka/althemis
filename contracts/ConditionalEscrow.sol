// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IConditionalPriceFeed {
    function getValue(bytes32 key) external view returns (int256);
    function deriveKey(uint8 asset, uint8 window, uint64 deadline) external pure returns (bytes32);
}

/**
 * ConditionalEscrow — bonded conditional commitments settled deterministically.
 *
 * A Provider DECLARES a verifiable success condition over a protocol-approved
 * feed (e.g. "BTC FR <= X after 8h") and BONDS capital behind it. A Consumer
 * then BUYS the claim by paying a premium. At the deadline anyone may settle:
 * the realized value is read from ConditionalPriceFeed via staticcall.
 *
 *   condition MET (provider was right)     → provider keeps the premium and
 *                                            recovers the bond.
 *   condition MISSED (provider was wrong)  → consumer receives the bond
 *                                            (the payout), provider keeps the
 *                                            premium.
 *   no buyer by the deadline               → provider recovers the bond in full
 *                                            (nobody was ever at risk).
 *
 * The Consumer is not buying the *condition* (public, copyable) — it is buying a
 * non-replicable claim on the Provider's bond if the declared condition fails.
 * This is insurance-shaped: the premium is the cost of a payout right; the bond
 * is the payout. bond and premium are both set by the Provider at declare time;
 * the market decides by choosing whether to buy.
 *
 * The protocol verifies the *condition*, never the *quality* of the inference.
 * Self-dealing is structurally impossible: the Provider signs only
 * (asset, window, op, expected); the escrow constructs the feed key itself, so
 * the condition can only ever resolve against the canonical feed.
 *
 * Deterministic successor to the abandoned probabilistic Phase B: outcomes are
 * read from public data, not scored as predictive skill. It sits alongside —
 * not inside — BondHook's slash path. A fabricated *fact* is still slashed
 * within minutes on the attestation jobs; a missed *condition* here pays the
 * bond out at the deadline. Two failures, two mechanisms.
 *
 * v1 scope: no protocol fee (0%), no challenger. Settlement is deterministic and
 * re-derivable by anyone, so it needs no challenge window.
 */
contract ConditionalEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // Comparison operator for the realized value vs the declared threshold.
    enum Op { GTE, LTE }

    // None      → never declared
    // Declared  → provider bonded + posted condition, awaiting a buyer
    // Purchased → consumer paid premium, live until deadline
    // Released  → settled, condition met (provider kept premium + bond)
    // PaidOut   → settled, condition missed (consumer received bond)
    // Withdrawn → no buyer by deadline, provider recovered bond
    enum Status { None, Declared, Purchased, Released, PaidOut, Withdrawn }

    struct Job {
        address provider;     // declares the condition, bonds capital
        address consumer;     // buys the claim (address(0) until purchased)
        uint256 bond;         // provider's stake; the payout if condition misses
        uint256 premium;      // consumer's cost for the claim
        uint8   asset;        // ASSET_BTC (v1)
        uint8   window;       // 8 | 16 | 24 (hours)
        Op      op;           // GTE | LTE
        int256  expected;     // provider-declared threshold X
        uint64  deadline;     // declareTime + window hours
        Status  status;
    }

    IERC20 public immutable usdc;
    IConditionalPriceFeed public immutable feed;

    uint8 public constant ASSET_BTC = 0;

    mapping(bytes32 => Job) public jobs;

    event Declared(
        bytes32 indexed jobId,
        address indexed provider,
        uint8 asset,
        uint8 window,
        Op op,
        int256 expected,
        uint256 bond,
        uint256 premium,
        uint64 deadline
    );
    event Purchased(bytes32 indexed jobId, address indexed consumer, uint256 premium);
    // condition met: provider kept premium + recovered bond
    event Released(bytes32 indexed jobId, address indexed provider, uint256 bond, uint256 premium, int256 realized);
    // condition missed: consumer received bond, provider kept premium
    event PaidOut(bytes32 indexed jobId, address indexed consumer, uint256 bond, uint256 premium, int256 realized);
    // no buyer by deadline: provider recovered bond
    event Withdrawn(bytes32 indexed jobId, address indexed provider, uint256 bond);

    error JobExists(bytes32 jobId);
    error UnsupportedAsset(uint8 asset);
    error UnsupportedWindow(uint8 window);
    error BadSignature();
    error NotDeclared(bytes32 jobId);
    error NotPurchased(bytes32 jobId);
    error AlreadyPurchased(bytes32 jobId);
    error BeforeDeadline(bytes32 jobId);
    error FeedNotReady(bytes32 jobId);
    error ZeroBond();

    constructor(address _usdc, address _feed) {
        usdc = IERC20(_usdc);
        feed = IConditionalPriceFeed(_feed);
    }

    /**
     * Binds ONLY the choosable parameters (asset, window, op, expected) — never a
     * raw target/calldata — so the condition can only ever resolve against the
     * canonical feed. Self-dealing is structurally impossible.
     */
    function declarationHash(uint8 asset, uint8 window, Op op, int256 expected)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(asset, window, op, expected));
    }

    /**
     * Provider declares a condition and bonds capital. The Provider is msg.sender
     * and transfers `bond` USDC into escrow; `providerSig` over declarationHash
     * proves authorship of exactly this (asset, window, op, expected).
     * `premium` is the price a Consumer must pay to buy the claim.
     */
    function declare(
        bytes32 jobId,
        uint8 asset,
        uint8 window,
        Op op,
        int256 expected,
        uint256 bond,
        uint256 premium,
        bytes calldata providerSig
    ) external nonReentrant {
        if (jobs[jobId].status != Status.None) revert JobExists(jobId);
        if (asset != ASSET_BTC) revert UnsupportedAsset(asset);
        if (window != 8 && window != 16 && window != 24) revert UnsupportedWindow(window);
        if (bond == 0) revert ZeroBond();

        _verifyDeclaration(msg.sender, asset, window, op, expected, providerSig);

        Job storage j = jobs[jobId];
        j.provider = msg.sender;
        j.consumer = address(0);
        j.bond     = bond;
        j.premium  = premium;
        j.asset    = asset;
        j.window   = window;
        j.op       = op;
        j.expected = expected;
        j.deadline = uint64(block.timestamp) + uint64(window) * 1 hours;
        j.status   = Status.Declared;

        usdc.safeTransferFrom(msg.sender, address(this), bond);

        emit Declared(jobId, msg.sender, asset, window, op, expected, bond, premium, j.deadline);
    }

    /**
     * Consumer buys the claim by paying the premium. From here the Consumer holds
     * a right to the bond if the condition misses at the deadline.
     */
    function purchase(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status == Status.None) revert NotDeclared(jobId);
        if (j.status != Status.Declared) revert AlreadyPurchased(jobId);

        j.consumer = msg.sender;
        j.status   = Status.Purchased;

        usdc.safeTransferFrom(msg.sender, address(this), j.premium);

        emit Purchased(jobId, msg.sender, j.premium);
    }

    /// Verify the Provider signed exactly this (asset, window, op, expected) declaration.
    function _verifyDeclaration(
        address provider,
        uint8 asset,
        uint8 window,
        Op op,
        int256 expected,
        bytes calldata providerSig
    ) internal pure {
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(
            declarationHash(asset, window, op, expected)
        );
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(ethHash, providerSig);
        if (err != ECDSA.RecoverError.NoError || recovered != provider) revert BadSignature();
    }

    /**
     * Permissionless settlement after the deadline for a PURCHASED job. Reads the
     * realized value from the feed and pays out deterministically. If the feed has
     * no value yet (oracle hasn't posted), the staticcall reverts and we surface
     * FeedNotReady — settlement simply waits, it never defaults to a payout.
     *
     *   met    → provider keeps premium + recovers bond
     *   missed → consumer receives bond (payout); provider keeps premium
     */
    function settle(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Purchased) revert NotPurchased(jobId);
        if (block.timestamp <= j.deadline) revert BeforeDeadline(jobId);

        bytes32 key = feed.deriveKey(j.asset, j.window, j.deadline);

        // staticcall so a reverting (not-yet-posted) feed read is caught here and
        // turned into FeedNotReady, rather than reverting the whole tx with an
        // opaque error. A successful read returns the realized value.
        (bool ok, bytes memory ret) = address(feed).staticcall(
            abi.encodeWithSelector(IConditionalPriceFeed.getValue.selector, key)
        );
        if (!ok || ret.length < 32) revert FeedNotReady(jobId);

        int256 realized = abi.decode(ret, (int256));
        bool met = _eval(j.op, realized, j.expected);

        uint256 bond = j.bond;
        uint256 premium = j.premium;

        if (met) {
            // Provider was right: keeps the premium, recovers the bond.
            j.status = Status.Released;
            usdc.safeTransfer(j.provider, bond + premium);
            emit Released(jobId, j.provider, bond, premium, realized);
        } else {
            // Provider was wrong: consumer receives the bond (payout);
            // provider still keeps the premium.
            j.status = Status.PaidOut;
            usdc.safeTransfer(j.consumer, bond);
            usdc.safeTransfer(j.provider, premium);
            emit PaidOut(jobId, j.consumer, bond, premium, realized);
        }
    }

    /**
     * If no Consumer bought the claim by the deadline, the Provider recovers the
     * full bond — nobody was ever at risk, so there is nothing to settle.
     * Callable only by the Provider on a still-Declared job past its deadline.
     */
    function withdraw(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Declared) revert NotDeclared(jobId);
        if (block.timestamp <= j.deadline) revert BeforeDeadline(jobId);

        uint256 bond = j.bond;
        j.status = Status.Withdrawn;
        usdc.safeTransfer(j.provider, bond);
        emit Withdrawn(jobId, j.provider, bond);
    }

    function _eval(Op op, int256 a, int256 b) internal pure returns (bool) {
        if (op == Op.GTE) return a >= b;
        return a <= b; // LTE
    }
}
