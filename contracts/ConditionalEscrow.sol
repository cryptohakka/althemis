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
 * ConditionalEscrow — predictions sold as conditional contracts, not graded forecasts.
 *
 * A Provider declares a verifiable, measurable success condition over a
 * protocol-approved feed (e.g. "BTC FR <= X after 8h"). The Consumer pays into
 * escrow. At the deadline, anyone can settle: the contract reads the realized
 * value from ConditionalPriceFeed via staticcall and either RELEASES the escrow
 * to the Provider (condition met) or REFUNDS the Consumer (condition not met).
 *
 * The protocol verifies the *condition*, never the *quality* of the inference.
 * The Provider cannot self-deal: it signs only (asset, window, op, expected);
 * the escrow constructs the feed target and calldata itself, so the condition
 * can only ever read the canonical feed.
 *
 * This is the deterministic successor to the abandoned probabilistic Phase B:
 * outcomes are read from public data, not scored as predictive skill. It sits
 * alongside — not inside — BondHook's slash path. A fabricated *fact* is still
 * slashed within minutes on the attestation jobs; a missed *condition* here is
 * simply refunded at the deadline. Two failures, two mechanisms.
 *
 * v1 scope: no protocol fee (0%), no bond, no challenger. Settlement is
 * deterministic and re-derivable by anyone, so it needs no challenge window.
 */
contract ConditionalEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using ECDSA for bytes32;

    // Comparison operator for the realized value vs the declared threshold.
    enum Op { GTE, LTE }

    enum Status { None, Open, Released, Refunded }

    struct Job {
        address consumer;
        address provider;
        uint256 amount;       // USDC held in escrow
        uint8   asset;        // ASSET_BTC (v1)
        uint8   window;       // 8 | 16 | 24 (hours)
        Op      op;           // GTE | LTE
        int256  expected;     // provider-declared threshold X
        uint64  deadline;     // commitTime + window hours
        Status  status;
    }

    IERC20 public immutable usdc;
    IConditionalPriceFeed public immutable feed;

    uint8 public constant ASSET_BTC = 0;

    mapping(bytes32 => Job) public jobs;

    event Committed(
        bytes32 indexed jobId,
        address indexed consumer,
        address indexed provider,
        uint8 asset,
        uint8 window,
        Op op,
        int256 expected,
        uint256 amount,
        uint64 deadline
    );
    event Released(bytes32 indexed jobId, address indexed provider, uint256 amount, int256 realized);
    event Refunded(bytes32 indexed jobId, address indexed consumer, uint256 amount, int256 realized);

    error JobExists(bytes32 jobId);
    error UnsupportedAsset(uint8 asset);
    error UnsupportedWindow(uint8 window);
    error BadSignature();
    error NotOpen(bytes32 jobId);
    error BeforeDeadline(bytes32 jobId);
    error FeedNotReady(bytes32 jobId);

    constructor(address _usdc, address _feed) {
        usdc = IERC20(_usdc);
        feed = IConditionalPriceFeed(_feed);
    }

    /**
     * The Provider's signed commitment. It binds ONLY the choosable parameters
     * (asset, window, op, expected) — never a raw target/calldata — so the
     * condition can only ever resolve against the canonical feed. self-dealing
     * is structurally impossible: the Provider has no way to point the condition
     * at a contract it controls.
     */
    function declarationHash(uint8 asset, uint8 window, Op op, int256 expected)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(asset, window, op, expected));
    }

    /**
     * Consumer commits payment to a Provider's declared condition.
     * The Consumer transfers `amount` USDC into escrow; the Provider's signature
     * over declarationHash proves they authored this exact condition.
     */
    function commit(
        bytes32 jobId,
        address provider,
        uint8 asset,
        uint8 window,
        Op op,
        int256 expected,
        uint256 amount,
        bytes calldata providerSig
    ) external nonReentrant {
        if (jobs[jobId].status != Status.None) revert JobExists(jobId);
        if (asset != ASSET_BTC) revert UnsupportedAsset(asset);
        if (window != 8 && window != 16 && window != 24) revert UnsupportedWindow(window);

        _verifyDeclaration(provider, asset, window, op, expected, providerSig);

        Job storage j = jobs[jobId];
        j.consumer = msg.sender;
        j.provider = provider;
        j.amount = amount;
        j.asset = asset;
        j.window = window;
        j.op = op;
        j.expected = expected;
        j.deadline = uint64(block.timestamp) + uint64(window) * 1 hours;
        j.status = Status.Open;

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Committed(jobId, msg.sender, provider, asset, window, op, expected, amount, j.deadline);
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
     * Permissionless settlement after the deadline. Reads the realized value
     * from the feed and pays out deterministically. If the feed has no value yet
     * (oracle hasn't posted), the staticcall reverts and we surface FeedNotReady
     * — settlement simply waits, it never defaults to a payout.
     */
    function settle(bytes32 jobId) external nonReentrant {
        Job storage j = jobs[jobId];
        if (j.status != Status.Open) revert NotOpen(jobId);
        if (block.timestamp <= j.deadline) revert BeforeDeadline(jobId);

        bytes32 key = feed.deriveKey(j.asset, j.window, j.deadline);

        // staticcall so a reverting (not-yet-posted) feed read is caught here
        // and turned into FeedNotReady, rather than reverting the whole tx with
        // an opaque error. A successful read returns the realized value.
        (bool ok, bytes memory ret) = address(feed).staticcall(
            abi.encodeWithSelector(IConditionalPriceFeed.getValue.selector, key)
        );
        if (!ok || ret.length < 32) revert FeedNotReady(jobId);

        int256 realized = abi.decode(ret, (int256));
        bool met = _eval(j.op, realized, j.expected);

        if (met) {
            j.status = Status.Released;
            usdc.safeTransfer(j.provider, j.amount);
            emit Released(jobId, j.provider, j.amount, realized);
        } else {
            j.status = Status.Refunded;
            usdc.safeTransfer(j.consumer, j.amount);
            emit Refunded(jobId, j.consumer, j.amount, realized);
        }
    }

    function _eval(Op op, int256 a, int256 b) internal pure returns (bool) {
        if (op == Op.GTE) return a >= b;
        return a <= b; // LTE
    }
}
