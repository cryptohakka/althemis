/**
 * protocol/conditional-provider.js
 * Provider-side conditional contract declaration. Reuses the FR signal
 * already computed for the (abandoned) probabilistic Phase B: instead of
 * an unscored directional claim, the Provider now declares a verifiable
 * threshold and sells it as a conditional contract (asset, window, op,
 * expected). The Consumer (CBUYER, reusing the existing autonomous-loop
 * wallet) escrows payment; outcome is read from public data at the
 * deadline — never graded as predictive skill.
 *
 * Runs alongside tickProvider/tickChallenger in main.js's runCycle —
 * independent escrow (ConditionalEscrow), independent state file, no
 * shared code path with BondHook's slash logic.
 */
import { keccak256, encodeAbiParameters, parseAbi, parseUnits } from 'viem';
import { getPublicClient } from './arc.js';

const CONDITIONAL_ESCROW_ADDRESS = process.env.CONDITIONAL_ESCROW_ADDRESS;
const ASSET_BTC = 0;
const WINDOW_HOURS = 8; // v1: match the existing FR_WINDOW_MS used elsewhere
const CONDITIONAL_PRICE_USDC = process.env.CONDITIONAL_PRICE_USDC || '0.05';
const FR_DECLARATION_OFFSET = parseFloat(process.env.FR_DECLARATION_OFFSET || '0.0001');

const CONDITIONAL_ESCROW_ABI = parseAbi([
  'function commit(bytes32 jobId, address provider, uint8 asset, uint8 window, uint8 op, int256 expected, uint256 amount, bytes providerSig) external',
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
 * Declares a conditional contract from this cycle's FR signal, if the
 * direction is non-neutral. Returns null (no claim) on a neutral signal —
 * same rule as the old Phase B: no direction, no claim, nothing sold.
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

  const provider = roster.PCHEAP; // most-reliable provider sells the first conditional contracts
  const consumer = roster.CBUYER; // reuse the existing autonomous-loop buyer wallet

  // offset = 1x MAD: declare that the realized FR will clear the no-contest
  // band by the deadline, in the direction the provider's z-score implies.
  // providers.js exposes no MAD; the declaration offset is an explicit,
  // operator-tunable parameter — this IS the Provider's stated boldness,
  // not a derived statistic. See FR_DECLARATION_OFFSET in .env.
  const offset = FR_DECLARATION_OFFSET;
  let op, expected;
  if (frSig.direction === 'short') {
    op = 1; // LTE — Provider claims FR will fall to/below this line
    expected = toFixedFR(frSig.avgFR - offset);
  } else {
    op = 0; // GTE — Provider claims FR will rise to/above this line
    expected = toFixedFR(frSig.avgFR + offset);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + BigInt(WINDOW_HOURS * 3600);
  const declarationHash = keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'int256' }],
      [ASSET_BTC, WINDOW_HOURS, op, expected]
    )
  );
  const providerSig = await provider.client.signMessage({ message: { raw: declarationHash } });

  const amount = parseUnits(CONDITIONAL_PRICE_USDC, dec);
  const jobId = keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'int256' }, { type: 'uint256' }],
      [provider.address, expected, BigInt(Date.now())]
    )
  );

  // approve then commit — same two-step consume pattern as escrow.ts's
  // fundJob (approve exactly `amount`, immediately spent, no standing allowance).
  const usdcAddress = process.env.USDC_ADDRESS;
  const approveHash = await consumer.client.writeContract({
    address: usdcAddress,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [CONDITIONAL_ESCROW_ADDRESS, amount],
    chain: consumer.client.chain,
  });
  const approveReceipt = await getPublicClient().waitForTransactionReceipt({ hash: approveHash });
  if (approveReceipt.status !== 'success') {
    throw new Error(`conditional commit:approve tx reverted: ${approveHash}`);
  }

  const hash = await consumer.client.writeContract({
    address: CONDITIONAL_ESCROW_ADDRESS,
    abi: CONDITIONAL_ESCROW_ABI,
    functionName: 'commit',
    args: [jobId, provider.address, ASSET_BTC, WINDOW_HOURS, op, expected, amount, providerSig],
    chain: consumer.client.chain,
  });

  console.log(`[conditional-provider] declared FR(BTC,${WINDOW_HOURS}h) ${frSig.direction === 'short' ? '<=' : '>='} ${expected} job=${jobId} tx=${hash}`);
}
