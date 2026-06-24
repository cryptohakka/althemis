// submit-honest.mjs — submit ONE honest FR attestation (VERIFIED path).
//
// Positive-path counterpart to fabricate.mjs for the README.
// We submit 0.00001 (~6-CEX median), well inside max(3×MAD, 1e-4), so Phase A
// verifies it: NO slash, verifiedCount increments, bondRateBps stays 20000.
//
// Run with main stopped (standalone demo path).

import 'dotenv/config';
import { parseUnits, keccak256, toBytes, decodeEventLog } from 'viem';
import { getPublicClient, loadRoster } from './protocol/arc.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseAbi } = require('viem');
import {
  ERC8183_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BOND_HOOK_ABI, getFreeBalance,
} from './protocol/escrow.js';
import { upsertJobState } from './protocol/job-state.js';

const ROLE      = process.env.ROLE || 'PHONEST'; // job_state tracking slot
const HONEST_FR = 0.00001;          // ~6-CEX median, inside max(3*MAD, 1e-4)
const DESC      = `FR_BTC_8h=${HONEST_FR};z=0.3;dir=long`;

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

const pub      = getPublicClient();
const roster   = loadRoster();
const consumer = roster.CBUYER.client;
const provider = roster[ROLE].client;
const providerAcct = { address: roster[ROLE].address };

async function writeTx(client, req) {
  const hash = await client.writeContract({ ...req, account: client.account, chain: client.chain });
  const rc   = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return rc;
}

async function main() {
  const dec    = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });
  const budget = parseUnits('1', dec);
  const bondNeeded = parseUnits('2', dec);

  const free = await getFreeBalance(providerAcct.address);
  console.log(`[honest] provider free bond: ${free} (need ${bondNeeded})`);
  if (free < bondNeeded) {
    console.log('[honest] topping up bond...');
    await writeTx(provider, {
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
      args: [BOND_HOOK_ADDRESS, bondNeeded],
    });
    await writeTx(provider, {
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: 'deposit',
      args: [bondNeeded],
    });
  }

  const deliverable = keccak256(toBytes(DESC));
  const expiredAt   = Math.floor(Date.now() / 1000) + 86400;

  console.log(`[honest] creating job with HONEST signal: ${DESC}`);

  const rcCreate = await writeTx(consumer, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'createJob',
    args: [providerAcct.address, process.env.ORACLE_WALLET_ADDRESS,
           expiredAt, DESC, BOND_HOOK_ADDRESS, 0n],
  });
  let jobId;
  for (const l of rcCreate.logs) {
    try {
      const ev = decodeEventLog({ abi: ERC8183_ABI, data: l.data, topics: l.topics });
      if (ev.eventName === 'JobCreated') { jobId = ev.args.jobId; break; }
    } catch {}
  }
  if (jobId === undefined) throw new Error('JobCreated event not found');

  await writeTx(provider, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'setBudget',
    args: [jobId, USDC_ADDRESS, budget, '0x'],
  });
  await writeTx(consumer, {
    address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
    args: [ERC8183_ADDRESS, budget],
  });
  await writeTx(consumer, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'fund',
    args: [jobId, budget, '0x'],
  });
  await writeTx(provider, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'submit',
    args: [jobId, deliverable, '0x'],
  });

  // Persist under this role WITHOUT clobbering other roles' records.
  upsertJobState(ROLE, {
    jobId: jobId.toString(), description: DESC,
    submittedAt: new Date().toISOString(), status: 'Submitted', fabricated: false,
  });

  console.log(`[honest] job #${jobId} submitted with HONEST signal (role=${ROLE}).`);
  console.log(`[honest] expect: VERIFIED -> verifiedCount 0->1, bondRateBps stays 20000`);
}

main().catch((e) => { console.error('[honest] error:', e); process.exit(1); });
