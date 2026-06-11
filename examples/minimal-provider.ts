/**
 * examples/minimal-provider.ts
 * Minimal Provider reference: deposit bond → create job → submit FR signal
 * ~50 lines of actual logic. Shows the full Provider-side flow.
 *
 * Usage:
 *   PROVIDER_PRIVATE_KEY=0x... tsx examples/minimal-provider.ts
 */
import 'dotenv/config';
import { createWalletClient, http, keccak256, toBytes, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arcChain, getPublicClient } from '../protocol/arc.js';
import {
  ERC8183_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BOND_HOOK_ABI,
  depositBond, submitSignal,
} from '../protocol/escrow.js';
import { parseAbi, type Address } from 'viem';

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

async function main() {
  const pk = process.env.PROVIDER_PRIVATE_KEY;
  if (!pk) throw new Error('PROVIDER_PRIVATE_KEY not set');

  const account = privateKeyToAccount(pk as `0x${string}`);
  const wallet  = createWalletClient({ account, chain: arcChain, transport: http(process.env.ARC_RPC_URL!) });
  const pub     = getPublicClient();
  const oracle  = process.env.ORACLE_ADDRESS as Address;  // evaluator = price oracle wallet
  const addr    = account.address;

  console.log(`[provider] address: ${addr}`);

  // ── 1. Deposit bond (Bronze: 2x budget) ───────────────────
  const budget   = parseUnits('0.10', 6); // 0.10 USDC
  const bondAmt  = parseUnits('0.20', 6); // Bronze: 200% × budget

  await wallet.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve', args: [BOND_HOOK_ADDRESS, bondAmt], account: account, chain: arcChain });
  await wallet.writeContract({ address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: 'deposit', args: [bondAmt], account: account, chain: arcChain });
  console.log(`[provider] bond deposited: ${bondAmt} USDC`);

  // ── 2. Create job → Consumer側の操作 (デモではスキップ) ─
  const signal = 'FR_BTC_8h=0.00032';

  // ── 3. setBudget ──────────────────────────────────────────
  // (Provider proposes price)
  // NOTE: in production Consumer creates job; Provider calls setBudget
  // Skipped in this demo — Consumer would call fund() after setBudget

  // ── 4. Submit signal (after Consumer funds) ───────────────
  // In production: watch for JobFunded event, then submit
  // For demo: assume jobId=1
  const latestJobId = await pub.readContract({ address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'jobCounter' }) as bigint;
  const deliverable = keccak256(toBytes(signal));
  const submitTx    = await wallet.writeContract({
    address: ERC8183_ADDRESS, abi: ERC8183_ABI,
    functionName: 'submit',
    args: [latestJobId, deliverable, '0x'],
    account: account, chain: arcChain,
  });
  console.log(`[provider] signal submitted: job=#${latestJobId} deliverable=${deliverable} tx=${submitTx}`);
  console.log(`[provider] oracle will verify "${signal}" against 6-CEX median in 8h`);
}

main().catch(err => { console.error(err); process.exit(1); });
