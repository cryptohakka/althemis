// fabricate.mjs — submit ONE intentionally fabricated FR attestation.
//
// Purpose: produce an on-chain SLASH tx under the CURRENT fabrication
//   threshold max(3×MAD, 0.0001), as evidence for the README.
//
// The honest 6-CEX median for BTC 8h FR sits around 1e-5. We submit 0.005
// (5e-3), ~300× the floor away from any plausible median — unambiguous
// fabrication, not borderline. Phase A detects it on the next poll and
// calls slashJob() automatically.
//
// THIS BURNS 80% OF THE LOCKED BOND (testnet USDC). Run with main stopped.

import 'dotenv/config';
import { createWalletClient, http, parseUnits, keccak256, toBytes,
         decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getPublicClient, arcChain } from './protocol/arc.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseAbi } = require('viem');
import {
  ERC8183_ADDRESS, BOND_HOOK_ADDRESS, USDC_ADDRESS,
  ERC8183_ABI, BOND_HOOK_ABI, getFreeBalance,
} from './protocol/escrow.js';
import { upsertJobState } from './protocol/job-state.js';

const ROLE      = process.env.ROLE || 'PLIAR';   // job_state tracking slot
const FAKE_FR   = 0.005;            // unambiguous fabrication
const FAKE_DESC = `FR_BTC_8h=${FAKE_FR};z=99;dir=long`;

const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
]);

const pub          = getPublicClient();
const chain        = arcChain;
const consumerAcct = privateKeyToAccount(process.env.CONSUMER_PRIVATE_KEY);
const providerAcct = privateKeyToAccount(process.env.PROVIDER_PRIVATE_KEY);
const consumer     = createWalletClient({ account: consumerAcct, chain, transport: http(process.env.ARC_RPC_URL) });
const provider     = createWalletClient({ account: providerAcct, chain, transport: http(process.env.ARC_RPC_URL) });

async function writeTx(client, req) {
  const hash = await client.writeContract({ ...req, account: client.account, chain });
  const rc   = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`tx reverted: ${hash}`);
  return rc;
}

async function main() {
  const dec    = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });
  const budget = parseUnits('1', dec);
  const bondNeeded = parseUnits('2', dec);

  const free = await getFreeBalance(providerAcct.address);
  console.log(`[fabricate] provider free bond: ${free} (need ${bondNeeded})`);
  if (free < bondNeeded) {
    console.log('[fabricate] topping up bond...');
    await writeTx(provider, {
      address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
      args: [BOND_HOOK_ADDRESS, bondNeeded],
    });
    await writeTx(provider, {
      address: BOND_HOOK_ADDRESS, abi: BOND_HOOK_ABI, functionName: 'deposit',
      args: [bondNeeded],
    });
  }

  const deliverable = keccak256(toBytes(FAKE_DESC));
  const expiredAt   = Math.floor(Date.now() / 1000) + 86400;

  console.log(`[fabricate] creating job with FABRICATED signal: ${FAKE_DESC}`);

  const rcCreate = await writeTx(consumer, {
    address: ERC8183_ADDRESS, abi: ERC8183_ABI, functionName: 'createJob',
    args: [providerAcct.address, process.env.ORACLE_WALLET_ADDRESS,
           expiredAt, FAKE_DESC, BOND_HOOK_ADDRESS, 0n],
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
    jobId: jobId.toString(), description: FAKE_DESC,
    submittedAt: new Date().toISOString(), status: 'Submitted', fabricated: true,
  });

  console.log(`[fabricate] job #${jobId} submitted with FABRICATED signal (role=${ROLE}).`);
  console.log(`[fabricate] watch: journalctl -u althemis-oracle -f`);
  console.log(`[fabricate] expect: SLASH ✗ fabricated attestation ... tx=0x...`);
}

main().catch((e) => { console.error('[fabricate] error:', e); process.exit(1); });
