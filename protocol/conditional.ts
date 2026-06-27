/**
 * protocol/conditional.ts
 * Conditional contract layer — the deterministic successor to the abandoned
 * probabilistic Phase B. A Provider declares a verifiable, measurable
 * condition (asset, window, op, expected); the Consumer escrows payment;
 * at the deadline, the realized value (read from ConditionalPriceFeed) either
 * releases the escrow to the Provider or refunds the Consumer. The protocol
 * verifies the *condition*, never the *quality* of the inference.
 *
 * Independent of ERC8183 / BondHook (case Y): own escrow, own state file,
 * own poll cycle. A fabricated *fact* is still slashed within minutes on the
 * attestation jobs (oracle.ts); a missed *condition* here is simply refunded
 * at the deadline. Two failures, two mechanisms, no shared code path.
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
  'event Committed(bytes32 indexed jobId, address indexed consumer, address indexed provider, uint8 asset, uint8 window, uint8 op, int256 expected, uint256 amount, uint64 deadline)',
  'event Released(bytes32 indexed jobId, address indexed provider, uint256 amount, int256 realized)',
  'event Refunded(bytes32 indexed jobId, address indexed consumer, uint256 amount, int256 realized)',
  'function settle(bytes32 jobId) external',
  'function jobs(bytes32) view returns (address consumer, address provider, uint256 amount, uint8 asset, uint8 window, uint8 op, int256 expected, uint64 deadline, uint8 status)',
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
  settled: boolean;
  outcome?: 'released' | 'refunded';
  realized?: string;      // realized FR value, fixed-point as string (avoid float precision loss in JSON)
  provider?: Hex;
  consumer?: Hex;
  amount?: string;
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

// ── 1. Discover new Committed jobs via logs ─────────────────────
async function scanForNewJobs(db: ConditionalStateDB): Promise<void> {
  const client = getPublicClient();
  const fromBlock = BigInt(db.lastScannedBlock) + 1n;
  const toBlock = await client.getBlockNumber();
  if (fromBlock > toBlock) return;

  const logs = await client.getLogs({
    address: CONDITIONAL_ESCROW_ADDRESS,
    event: CONDITIONAL_ESCROW_ABI[0],
    fromBlock,
    toBlock,
  });

  for (const log of logs) {
    const { args } = decodeEventLog({ abi: CONDITIONAL_ESCROW_ABI, ...log });
    const a = args as any;
    db.jobs[a.jobId] = {
      jobId: a.jobId,
      asset: a.asset,
      window: a.window,
      deadline: Number(a.deadline),
      settled: false,
      provider: a.provider,
      consumer: a.consumer,
      amount: a.amount?.toString(),
      op: a.op,
      expected: a.expected?.toString(),
    };
    console.log(`[conditional] discovered job ${a.jobId} asset=${a.asset} window=${a.window}h deadline=${a.deadline}`);
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

// ── 3. Settle jobs whose value has been posted ──────────────────
async function settleMaturedJobs(db: ConditionalStateDB): Promise<void> {
  const client = getPublicClient();
  const wallet = getOracleClient();
  const nowSec = Math.floor(Date.now() / 1000);

  for (const job of Object.values(db.jobs)) {
    if (job.settled) continue;
    if (nowSec <= job.deadline) continue;

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
      // Decode whichever event (Released or Refunded) this settle emitted —
      // settle() always emits exactly one of the two, so this is exhaustive.
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: CONDITIONAL_ESCROW_ABI, ...log });
          if (decoded.eventName === 'Released' || decoded.eventName === 'Refunded') {
            const a = decoded.args as any;
            job.outcome = decoded.eventName === 'Released' ? 'released' : 'refunded';
            job.realized = a.realized?.toString();
            break;
          }
        } catch { /* not a log from this contract's ABI, skip */ }
      }
      job.settled = true;
      console.log(`[conditional] settled job ${job.jobId} outcome=${job.outcome} realized=${job.realized} tx=${hash}`);
    } catch (err) {
      console.log(`[conditional] job ${job.jobId} settle failed (likely already settled by another caller): ${err}`);
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
  // Each phase is independently fault-tolerant: a transient RPC failure
  // (e.g. pruned-history range errors) in one phase must never crash the
  // whole oracle service or block the others. processJobs (Phase A/B on
  // the unrelated ERC8183/BondHook path) must keep running regardless.
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
