// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * ConditionalPriceFeed — settlement oracle for ConditionalEscrow.
 *
 * A single trusted oracle (althemis-oracle.service) posts the realized
 * value (e.g. 6-CEX FR median) for a given (asset, window, deadline) key
 * at the moment that window matures. ConditionalEscrow reads it back via
 * staticcall to settle a conditional contract.
 *
 * Trust model (v1): identical to Phase A — a single oracle posts a value
 * that anyone can reproduce from the same 6 public CEX endpoints, and every
 * write is logged. The value is deterministic and re-derivable; the oracle
 * cannot post a fabricated value without it being externally falsifiable
 * after the fact. Permissionless feed-value challenges (the BondVault
 * optimistic pattern applied to the feed) are deferred to v2.
 *
 * Values are int256 because funding rates are signed.
 */
contract ConditionalPriceFeed is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    // key => realized value (signed; FR can be negative)
    mapping(bytes32 => int256) private _value;
    // key => whether a value has been posted (distinguishes a genuine 0 from "unset")
    mapping(bytes32 => bool) public posted;

    event ValuePosted(bytes32 indexed key, int256 value, address indexed oracle);

    error AlreadyPosted(bytes32 key);
    error NotPosted(bytes32 key);

    constructor(address admin, address oracle) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
    }

    /**
     * Derive the canonical key for a settlement point. Pure and public so the
     * oracle, the escrow, and any external verifier all compute the same key.
     */
    function deriveKey(uint8 asset, uint8 window, uint64 deadline)
        public pure returns (bytes32)
    {
        return keccak256(abi.encode(asset, window, deadline));
    }

    /**
     * Post the realized value for a settlement key. Write-once: a key cannot be
     * overwritten, so a posted settlement value is immutable on-chain.
     */
    function postValue(bytes32 key, int256 value) external onlyRole(ORACLE_ROLE) {
        if (posted[key]) revert AlreadyPosted(key);
        _value[key] = value;
        posted[key] = true;
        emit ValuePosted(key, value, msg.sender);
    }

    /**
     * Read the realized value. Reverts if not yet posted, so a settlement that
     * runs before the oracle has written the value fails the staticcall cleanly
     * (ConditionalEscrow treats that as "not yet settleable", never as a result).
     */
    function getValue(bytes32 key) external view returns (int256) {
        if (!posted[key]) revert NotPosted(key);
        return _value[key];
    }
}
