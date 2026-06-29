/**
 * protocol/conditional.ts
 * Bonded conditional commitment layer — the deterministic successor to the
 * abandoned probabilistic Phase B. A Provider DECLARES a verifiable condition
 * (asset, window, op, expected) and BONDS capital; a Consumer BUYS the claim by
 * paying a premium. At the deadline the realized value (read from
 * ConditionalPriceFeed) settles deterministically:
 *
 *   met    → provider keeps premium + recovers bond  (Released)
 *   missed → consumer receives bond (payout)          (PaidOut)
 *   no buyer by deadline → provider recovers bond      (Withdrawn)
 *
 * The protocol verifies the *condition*, never the *quality* of the inference.
 *
 * Independent of ERC8183 / BondHook: own escrow, own state file, own poll
 * cycle. A fabricated *fact* is still slashed within minutes on the attestation
 * jobs (oracle.ts); a missed *condition* here pays out the bond at the deadline.
 * Two failures, two mechanisms, no shared code path.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parseAbi, decodeEventLog, type Address, type Hex } from 'viem';
import { getPublicClient, getOracleClient } from './arc.js';
import { fetch6CexFR, medianMad } from './oracle.js';

// ── Config ───────────────────────────────────────────────────
const STATE_PATH = 'data/conditional_state.json';
const ASSET_BTC = 0;

const CONDITIONAL_ESCROW_ADDRESS = process.env.CONDITIONAL_ESCROW_ADDRESS as Address;
const CONDITIONAL_FEED_ADDRESS   = process.env.CONDITIONAL_FEED_ADDRESS as Address;

// ── ABIs (human-readable, subset used here — same pattern as escrow.ts) ──
const CONDITIONAL_ESCROW_ABI = parseAbi([
  'event Declared(bytes32 indexed jobId, address indexed provider, uint8 asset, uint8 window, uint8 op, int256 expected, uint256 bond, uint256 premium, uint64 deadline)',
  'event Purchased(bytes32 indexed jobId, address indexed consumer, uint256 premium)',
  'event Released(bytes32 indexed jobId, address indexed provider, uint256 bond, uint256 premium, int256 realized)',
  'event PaidOut(bytes32 indexed jobId, address indexed consumer, uint256 bond, uint256 premium, int256 realized)',
  'event Withdrawn(bytes32 indexed jobId, address indexed provider, uint256 bond)',
  'function settle(bytes32 jobId) external',
  'function withdraw(bytes32 jobId) external',
  'function jobs(bytes32) view returns (address provider, address consumer, uint256 bond, uint256 premium, uint8 asset, uint8 window, uint8 op, int256 expected, uint64 deadline, uint8 status)',
]);

const CONDITIONAL_FEED_ABI = parseAbi([
  'function deriveKey(uint8 asset, uint8 window, uint64 deadline) pure returns (bytes32)',
  'function postValue(bytes32 key, int256 value) external',
  'function posted(bytes32) view returns (bool)',
]);

// ── State ────────────────────────────────────────────────────
type TrackedJob = {
  jobId: Hex;
  asset: number;
  window: number;
  deadline: number;
  purchased: boolean;     // a consumer bought the claim
  settled: boolean;
  outcome?: 'released' | 'paidout' | 'withdrawn';
  realized?: string;      // realized FR value, fixed-point as string
  provider?: Hex;
  consumer?: Hex;
  bond?: string;
  premium?: string;
  op?: number;
  expected?: string;      // declared threshold, fixed-point as string
};
type ConditionalStateDB = {
  lastScannedBlock: string;
  jobs: Record<string, TrackedJob>;
};

function loadState(): ConditionalStateDB {
  if (!existsSync(STATE_PATH)) return { lastScannedBlock: '0', jobs: {} };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}
function saveState(db: ConditionalStateDB): void {
  writeFileSync(STATE_PATH, JSON.stringify(db, null, 2));
}

// ── 1. Discover Declared jobs and Purchased updates via logs ────
async function scanForNewJobs(db: ConditionalStateDB): Promise<void> {
  const client = getPublicClient();
  const fromBlock = BigInt(db.lastScannedBlock) + 1n;
  const toBlock = await client.getBlockNumber();
  if (fromBlock > toBlock) return;

  // Declared (event[0]) — a new bonded condition appears.
  const declaredLogs = await client.getLogs({
    address: CONDITIONAL_ESCROW_ADDRESS,
    event: CONDITIONAL_ESCROW_ABI[0],
    fromBlock,
    toBlock,
  });
  for (const log of declaredLogs) {
    const { args } = decodeEventLog({ abi: CONDITIONAL_ESCROW_ABI, ...log });
    const a = args as any;
    if (!db.jobs[a.jobId]) {
      db.jobs[a.jobId] = {
        jobId: a.jobId,
        asset: a.asset,
        window: a.window,
        deadline: Number(a.deadline),
        purchased: false,
        settled: false,
        provider: a.provider,
        bond: a.bond?.toString(),
        premium: a.premium?.toString(),
        op: a.op,
        expected: a.expected?.toString(),
      };
      console.log(`[conditional] declared job ${a.jobId} asset=${a.asset} window=${a.window}h bond=${a.bond} premium=${a.premium} deadline=${a.deadline}`);
    }
  }

  // Purchased (event[1]) — a consumer bought the claim; mark it settleable.
  const purchasedLogs = await client.getLogs({
    address: CONDITIONAL_ESCROW_ADDRESS,
    event: CONDITIONAL_ESCROW_ABI[1],
    fromBlock,
    toBlock,
  });
  for (const log of purchasedLogs) {
    const { args } = decodeEventLog({ abi: CONDITIONAL_ESCROW_ABI, ...log });
    const a = args as any;
    const job = db.jobs[a.jobId];
    if (job) {
      job.purchased = true;
      job.consumer = a.consumer;
      console.log(`[conditional] purchased job ${a.jobId} consumer=${a.consumer}`);
    }
  }

  db.lastScannedBlock = toBlock.toString();
}

// ── 2. Post the realized FR for jobs whose window has just matured ─────
async function postMaturedValues(db: ConditionalStateDB): Promise<void> {
  const client = getPublicClient();
  const wallet = getOracleClient();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const job of Object.values(db.jobs)) {
    if (job.settled) continue;
    if (nowSec <= job.deadline) continue;
    if (job.asset !== ASSET_BTC) continue;

    const key = await client.readContract({
      address: CONDITIONAL_FEED_ADDRESS,
      abi: CONDITIONAL_FEED_ABI,
      functionName: 'deriveKey',
      args: [job.asset, job.window, BigInt(job.deadline)],
    });

    const alreadyPosted = await client.readContract({
      address: CONDITIONAL_FEED_ADDRESS,
      abi: CONDITIONAL_FEED_ABI,
      functionName: 'posted',
      args: [key],
    });
    if (alreadyPosted) continue;

    const cexData = await fetch6CexFR('BTC');
    if (cexData.length < 4) {
      console.log(`[conditional] job ${job.jobId}: CEX quorum not met yet, retry next poll`);
      continue;
    }
    const { median } = medianMad(cexData.map(d => d.rate));
    const realizedFixed = BigInt(Math.round(median * 1e6));

    const hash = await wallet.writeContract({
      address: CONDITIONAL_FEED_ADDRESS,
      abi: CONDITIONAL_FEED_ABI,
      functionName: 'postValue',
      args: [key, realizedFixed],
      chain: wallet.chain!,
    });
    console.log(`[conditional] posted FR for job ${job.jobId}: ${median} (fixed=${realizedFixed}) tx=${hash}`);
  }
}

// ── 3. Settle (purchased) or withdraw (no buyer) matured jobs ───
async function settleMaturedJobs(db: ConditionalStateDB): Promise<void> {
  const client = getPublicClient();
  const wallet = getOracleClient();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const job of Object.values(db.jobs)) {
    if (job.settled) continue;
    if (nowSec <= job.deadline) continue;

    // No buyer by the deadline → provider withdraws the bond. Nothing to settle.
    if (!job.purchased) {
      try {
        const hash = await wallet.writeContract({
          address: CONDITIONAL_ESCROW_ADDRESS,
          abi: CONDITIONAL_ESCROW_ABI,
          functionName: 'withdraw',
          args: [job.jobId],
          chain: wallet.chain!,
        });
        await client.waitForTransactionReceipt({ hash });
        job.settled = true;
        job.outcome = 'withdrawn';
        console.log(`[conditional] withdrawn (no buyer) job ${job.jobId} tx=${hash}`);
      } catch (err) {
        console.log(`[conditional] job ${job.jobId} withdraw failed (likely already handled): ${err instanceof Error ? err.message : err}`);
        job.settled = true;
      }
      continue;
    }

    // Purchased → settle requires the feed value to be posted first.
    const key = await client.readContract({
      address: CONDITIONAL_FEED_ADDRESS,
      abi: CONDITIONAL_FEED_ABI,
      functionName: 'deriveKey',
      args: [job.asset, job.window, BigInt(job.deadline)],
    });
    const posted = await client.readContract({
      address: CONDITIONAL_FEED_ADDRESS,
      abi: CONDITIONAL_FEED_ABI,
      functionName: 'posted',
      args: [key],
    });
    if (!posted) continue;

    try {
      const hash = await wallet.writeContract({
        address: CONDITIONAL_ESCROW_ADDRESS,
        abi: CONDITIONAL_ESCROW_ABI,
        functionName: 'settle',
        args: [job.jobId],
        chain: wallet.chain!,
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      // settle() emits exactly one of Released (met) or PaidOut (missed).
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: CONDITIONAL_ESCROW_ABI, ...log });
          if (decoded.eventName === 'Released' || decoded.eventName === 'PaidOut') {
            const a = decoded.args as any;
            job.outcome = decoded.eventName === 'Released' ? 'released' : 'paidout';
            job.realized = a.realized?.toString();
            break;
          }
        } catch { /* not a log from this contract's ABI, skip */ }
      }
      job.settled = true;
      console.log(`[conditional] settled job ${job.jobId} outcome=${job.outcome} realized=${job.realized} tx=${hash}`);
    } catch (err) {
      console.log(`[conditional] job ${job.jobId} settle failed (likely already settled by another caller): ${err instanceof Error ? err.message : err}`);
      job.settled = true;
    }
  }
}

// ── Entry point, called from oracle.ts's poll cycle ─────────────
export async function processConditionalJobs(): Promise<void> {
  if (!CONDITIONAL_ESCROW_ADDRESS || !CONDITIONAL_FEED_ADDRESS) {
    console.log('[conditional] CONDITIONAL_ESCROW_ADDRESS / CONDITIONAL_FEED_ADDRESS not set, skipping');
    return;
  }
  const db = loadState();
  // Each phase is independently fault-tolerant: a transient RPC failure in one
  // phase must never crash the whole oracle service or block the others.
  try {
    await scanForNewJobs(db);
  } catch (err) {
    console.error('[conditional] scanForNewJobs failed, will retry next poll:', err instanceof Error ? err.message : err);
  }
  try {
    await postMaturedValues(db);
  } catch (err) {
    console.error('[conditional] postMaturedValues failed, will retry next poll:', err instanceof Error ? err.message : err);
  }
  try {
    await settleMaturedJobs(db);
  } catch (err) {
    console.error('[conditional] settleMaturedJobs failed, will retry next poll:', err instanceof Error ? err.message : err);
  }
  saveState(db);
}
