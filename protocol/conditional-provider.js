/**
 * protocol/conditional-provider.js
 * Provider-side bonded conditional commitment. Reuses the FR signal already
 * computed for the (abandoned) probabilistic Phase B: instead of an unscored
 * directional claim, the Provider DECLARES a verifiable threshold and BONDS
 * capital behind it (asset, window, op, expected, bond). A Consumer then BUYS
 * the claim by paying a premium.
 *
 *   condition met (provider right)  → provider keeps premium + recovers bond
 *   condition missed (provider wrong)→ consumer receives bond (payout),
 *                                      provider keeps premium
 *
 * The Consumer is not buying the public condition — it buys a non-replicable
 * claim on the Provider's bond if the condition fails. Insurance-shaped:
 * premium is the cost of a payout right, bond is the payout. Both are set by
 * the Provider at declare time; the market decides by choosing to buy.
 *
 * In this self-dealing demo both sides are the operator's own roster
 * (PCHEAP declares+bonds, CBUYER — the autonomous-loop wallet — purchases),
 * so the full declare→purchase→settle→payout path is exercised end-to-end.
 * Disclosed as Layer 3: there are no external paying agents yet.
 *
 * Runs alongside tickProvider/tickChallenger in main.js's runCycle —
 * independent escrow (ConditionalEscrow), independent state file, no shared
 * code path with BondHook's slash logic.
 */
import { keccak256, encodeAbiParameters, parseAbi, parseUnits } from 'viem';
import { getPublicClient } from './arc.js';

const CONDITIONAL_ESCROW_ADDRESS = process.env.CONDITIONAL_ESCROW_ADDRESS;
const ASSET_BTC = 0;
const WINDOW_HOURS = 8; // v1: match the existing FR_WINDOW_MS used elsewhere
const CONDITIONAL_BOND_USDC    = process.env.CONDITIONAL_BOND_USDC    || '0.05';
const CONDITIONAL_PREMIUM_USDC = process.env.CONDITIONAL_PREMIUM_USDC || '0.005';
const FR_DECLARATION_OFFSET = parseFloat(process.env.FR_DECLARATION_OFFSET || '0.0001');

const CONDITIONAL_ESCROW_ABI = parseAbi([
  'function declare(bytes32 jobId, uint8 asset, uint8 window, uint8 op, int256 expected, uint256 bond, uint256 premium, bytes providerSig) external',
  'function purchase(bytes32 jobId) external',
]);

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// FR is stored fixed-point (rate * 1e6) to match the on-chain int256 scale
// used by ConditionalPriceFeed — keep this identical to protocol/conditional.ts.
function toFixedFR(rate) {
  return BigInt(Math.round(rate * 1e6));
}

/**
 * Declares + bonds a conditional contract from this cycle's FR signal, if the
 * direction is non-neutral, then (self-dealing demo) buys the claim from the
 * CBUYER wallet. Returns null (no claim) on a neutral signal — same rule as the
 * old Phase B: no direction, no claim, nothing sold.
 */
export async function tickConditional(roster, frSig, dec) {
  if (frSig.direction === 'neutral') {
    console.log('[conditional-provider] neutral signal — no condition to declare, skip');
    return;
  }
  if (!CONDITIONAL_ESCROW_ADDRESS) {
    console.log('[conditional-provider] CONDITIONAL_ESCROW_ADDRESS not set, skip');
    return;
  }

  const provider = roster.PCHEAP; // most-reliable provider declares + bonds
  const consumer = roster.CBUYER; // reuse the existing autonomous-loop buyer wallet

  // offset = 1x MAD: declare that the realized FR will clear the no-contest
  // band by the deadline, in the direction the provider's z-score implies.
  // This IS the Provider's stated boldness, not a derived statistic.
  const offset = FR_DECLARATION_OFFSET;
  let op, expected;
  if (frSig.direction === 'short') {
    op = 1; // LTE — Provider claims FR will fall to/below this line
    expected = toFixedFR(frSig.avgFR - offset);
  } else {
    op = 0; // GTE — Provider claims FR will rise to/above this line
    expected = toFixedFR(frSig.avgFR + offset);
  }

  const declarationHash = keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'int256' }],
      [ASSET_BTC, WINDOW_HOURS, op, expected]
    )
  );
  const providerSig = await provider.client.signMessage({ message: { raw: declarationHash } });

  const bond    = parseUnits(CONDITIONAL_BOND_USDC, dec);
  const premium = parseUnits(CONDITIONAL_PREMIUM_USDC, dec);
  const jobId = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'int256' }, { type: 'uint256' }],
      [provider.address, expected, BigInt(Date.now())]
    )
  );

  const usdcAddress = process.env.USDC_ADDRESS;
  const pub = getPublicClient();

  // ── 1. Provider declares + bonds: approve(bond) then declare() ──
  const bondApproveHash = await provider.client.writeContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [CONDITIONAL_ESCROW_ADDRESS, bond],
    chain: provider.client.chain,
  });
  const bondApproveReceipt = await pub.waitForTransactionReceipt({ hash: bondApproveHash });
  if (bondApproveReceipt.status !== 'success') {
    throw new Error(`conditional declare:approve(bond) tx reverted: ${bondApproveHash}`);
  }

  const declareHash = await provider.client.writeContract({
    address: CONDITIONAL_ESCROW_ADDRESS,
    abi: CONDITIONAL_ESCROW_ABI,
    functionName: 'declare',
    args: [jobId, ASSET_BTC, WINDOW_HOURS, op, expected, bond, premium, providerSig],
    chain: provider.client.chain,
  });
  const declareReceipt = await pub.waitForTransactionReceipt({ hash: declareHash });
  if (declareReceipt.status !== 'success') {
    throw new Error(`conditional declare tx reverted: ${declareHash}`);
  }
  console.log(`[conditional-provider] declared FR(BTC,${WINDOW_HOURS}h) ${frSig.direction === 'short' ? '<=' : '>='} ${expected} bond=${CONDITIONAL_BOND_USDC} premium=${CONDITIONAL_PREMIUM_USDC} job=${jobId} tx=${declareHash}`);

  // ── 2. Consumer buys the claim: approve(premium) then purchase() ──
  const premApproveHash = await consumer.client.writeContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [CONDITIONAL_ESCROW_ADDRESS, premium],
    chain: consumer.client.chain,
  });
  const premApproveReceipt = await pub.waitForTransactionReceipt({ hash: premApproveHash });
  if (premApproveReceipt.status !== 'success') {
    throw new Error(`conditional purchase:approve(premium) tx reverted: ${premApproveHash}`);
  }

  const purchaseHash = await consumer.client.writeContract({
    address: CONDITIONAL_ESCROW_ADDRESS,
    abi: CONDITIONAL_ESCROW_ABI,
    functionName: 'purchase',
    args: [jobId],
    chain: consumer.client.chain,
  });
  const purchaseReceipt = await pub.waitForTransactionReceipt({ hash: purchaseHash });
  if (purchaseReceipt.status !== 'success') {
    throw new Error(`conditional purchase tx reverted: ${purchaseHash}`);
  }
  console.log(`[conditional-provider] purchased claim job=${jobId} tx=${purchaseHash}`);
}
