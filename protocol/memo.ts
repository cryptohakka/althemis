/**
 * protocol/memo.ts
 * Arc Transaction Memo wrapper — confirmed against on-chain verified source
 * (Circle Memo.sol + IMemo.sol, Apache-2.0, 0x5294…Cede505, solc 0.8.29 prague).
 *
 *   function memo(address target, bytes data, bytes32 memoId, bytes memoData)
 *     → CALL_FROM.callFrom(msg.sender, target, data)  (sender preserved via precompile)
 *     → emit Memo(sender, target, callDataHash, memoId, memoData, memoIndex)
 *     → reverts MemoFailed(returnData) if the inner call fails (atomic; no orphan job)
 *
 *   Event (indexed flags confirmed from IMemo.sol):
 *     Memo(address indexed sender, address indexed target, bytes32 callDataHash,
 *          bytes32 indexed memoId, bytes memo, uint256 memoIndex)
 *   → memoId is indexed ⇒ getLogs can filter by jobId directly (dashboard join key).
 *
 * ⚠ EOA-ONLY: callFrom rejects contract callers (sender-spoofing guard) and reverts.
 *   PCONF is a raw EOA (makeWalletClient(PCONF_PRIVATE_KEY)) ⇒ satisfied. If
 *   commissioning ever moves to a smart account, this path reverts — fall back
 *   to plain submitSignal there.
 */
import { parseAbi, type Address } from 'viem';

export const MEMO_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505' as Address;

export const MEMO_ABI = parseAbi([
  'function memo(address target, bytes data, bytes32 memoId, bytes memoData)',
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
  'event BeforeMemo(uint256 indexed memoIndex)',
]);
