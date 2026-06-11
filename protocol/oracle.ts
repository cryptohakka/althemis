/**
 * protocol/oracle.ts
 * Price Oracle — ERC-8183 evaluator for Althemis signal marketplace
 *
 * Per signal type (06-12 design):
 *   FR  attestation: N=8h window, no-contest if |submitted - median| < 0.5σ (MAD proxy)
 *   OI  attestation: N=4h window, no-contest if |submitted - median| < 0.3% OI
 *   Regime: rule-based settlement (vol pct70/30 + 8h trend), handled separately
 *
 * Loop:
 *   1. Fetch all Submitted jobs
 *   2. For each job past N-hour confirmation window:
 *      a. Decode deliverable (keccak256 of "TYPE_ASSET_Nh=VALUE")
 *      b. Fetch current 6-CEX data and compute median ± MAD
 *      c. complete() if within threshold, slashJob() if outside
 *   3. Run tier updates via tier.ts
 *   4. Sleep POLL_INTERVAL
 */

import 'dotenv/config';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import { getPublicClient } from './arc.js';
import {
  getSubmittedJobs, completeJob, slashJob,
  ERC8183_ADDRESS, ERC8183_ABI,
  type Job, JobStatus,
} from './escrow.js';
import { recordOutcome } from './tier.js';

// ── Config ────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

// Confirmation windows (ms)
const FR_WINDOW_MS  = 8  * 60 * 60 * 1000; // 8h
const OI_WINDOW_MS  = 4  * 60 * 60 * 1000; // 4h

// Attestation no-contest thresholds
const FR_MAD_MULTIPLIER = 0.5;  // |submitted - median| < 0.5 × MAD
const OI_THRESHOLD_PCT  = 0.003; // 0.3% absolute

// ── Signal types ──────────────────────────────────────────────
type SignalType = 'FR' | 'OI' | 'REGIME';

interface DeliveryDecoded {
  type:   SignalType;
  asset:  string;       // e.g. "BTC"
  window: string;       // e.g. "8h"
  value:  number;       // e.g. 0.00032 (FR as decimal)
  raw:    string;       // original string before hashing
}

/**
 * Deliverable format: "FR_BTC_8h=0.00032"
 * The Provider hashes this string and submits keccak256 as deliverable.
 * The oracle needs to know the preimage — in v1, Providers post the preimage
 * off-chain (e.g. via description or memo). For v1 simplicity we read it
 * from job.description field: "FR_BTC_8h=0.00032"
 */
function decodeDelivery(description: string): DeliveryDecoded | null {
  // Format: "TYPE_ASSET_Wh=VALUE"
  const match = description.match(/^(FR|OI|REGIME)_([A-Z]+)_(\d+h)=(-?[\d.]+)$/);
  if (!match) return null;
  return {
    type:   match[1] as SignalType,
    asset:  match[2],
    window: match[3],
    value:  parseFloat(match[4]),
    raw:    description,
  };
}

// ── 6-CEX data fetching ───────────────────────────────────────
// Mirrors cex.js logic but in TypeScript, returns { median, mad }
interface CexFrData {
  exchange: string;
  rate: number;
}

async function fetch6CexFR(asset: string): Promise<CexFrData[]> {
  // Exchanges: Binance, Bybit, Bitget, OKX, Gate, MEXC (public funding rate APIs)
  const symbol = `${asset}USDT`;
  const results: CexFrData[] = [];

  const fetchers: Array<[string, () => Promise<number | null>]> = [
    ['Binance', async () => {
      const r = await fetch(
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`
      );
      const d = await r.json() as any[];
      return d?.[0] ? parseFloat(d[0].fundingRate) : null;
    }],
    ['Bybit', async () => {
      const r = await fetch(
        `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`
      );
      const d = await r.json() as any;
      return d?.result?.list?.[0] ? parseFloat(d.result.list[0].fundingRate) : null;
    }],
    ['OKX', async () => {
      const r = await fetch(
        `https://www.okx.com/api/v5/public/funding-rate?instId=${asset}-USDT-SWAP`
      );
      const d = await r.json() as any;
      return d?.data?.[0] ? parseFloat(d.data[0].fundingRate) : null;
    }],
    ['Bitget', async () => {
      const r = await fetch(
        `https://api.bitget.com/api/v2/mix/market/current-fund-rate?symbol=${symbol}&productType=USDT-FUTURES`
      );
      const d = await r.json() as any;
      return d?.data?.[0] ? parseFloat(d.data[0].fundingRate) : null;
    }],
    ['Gate', async () => {
      const r = await fetch(
        `https://api.gateio.ws/api/v4/futures/usdt/contracts/${asset}_USDT`
      );
      const d = await r.json() as any;
      return d?.funding_rate ? parseFloat(d.funding_rate) : null;
    }],
    ['MEXC', async () => {
      const r = await fetch(
        `https://contract.mexc.com/api/v1/contract/funding_rate/${asset}_USDT`
      );
      const d = await r.json() as any;
      return d?.data?.fundingRate ? parseFloat(d.data.fundingRate) : null;
    }],
  ];

  await Promise.allSettled(
    fetchers.map(async ([name, fn]) => {
      try {
        const rate = await fn();
        if (rate !== null) results.push({ exchange: name, rate });
      } catch { /* skip failed exchange */ }
    })
  );

  return results;
}

/** Compute median and MAD (Median Absolute Deviation) */
function medianMad(values: number[]): { median: number; mad: number } {
  if (values.length === 0) return { median: 0, mad: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const deviations = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const madMid = Math.floor(deviations.length / 2);
  const mad    = deviations.length % 2 === 0
    ? (deviations[madMid - 1] + deviations[madMid]) / 2
    : deviations[madMid];
  return { median, mad };
}

// ── Verification logic ────────────────────────────────────────

interface VerifyResult {
  pass:     boolean;
  reason:   string;
  verified: Hex;   // keccak256 of verification summary (used as complete() reason)
}

async function verifyFR(delivered: DeliveryDecoded): Promise<VerifyResult> {
  const cexData = await fetch6CexFR(delivered.asset);
  if (cexData.length < 3) {
    return { pass: false, reason: `insufficient CEX data (${cexData.length})`, verified: '0x' as Hex };
  }

  const rates = cexData.map(d => d.rate);
  const { median, mad } = medianMad(rates);
  const diff  = Math.abs(delivered.value - median);
  const threshold = mad * FR_MAD_MULTIPLIER;

  const summary = `FR_VERIFY:asset=${delivered.asset},submitted=${delivered.value},median=${median.toFixed(6)},mad=${mad.toFixed(6)},diff=${diff.toFixed(6)},threshold=${threshold.toFixed(6)}`;
  const verified = keccak256(toBytes(summary)) as Hex;

  const pass = diff <= threshold;
  const reason = pass
    ? `PASS: diff=${diff.toFixed(6)} <= threshold=${threshold.toFixed(6)}`
    : `FAIL: diff=${diff.toFixed(6)} > threshold=${threshold.toFixed(6)}`;

  console.log(`[oracle][FR] ${delivered.raw} | ${reason} | exchanges=${cexData.map(d => d.exchange).join(',')}`);
  return { pass, reason, verified };
}

async function verifyOI(delivered: DeliveryDecoded): Promise<VerifyResult> {
  // OI verification: compare against 6-CEX OI (simplified: use FR proxy for now)
  // TODO: implement actual OI fetching per-CEX
  // For v1: pass if submitted value is within 0.3% of a reference
  // Placeholder — replace with actual OI data
  const summary = `OI_VERIFY:asset=${delivered.asset},submitted=${delivered.value},status=PLACEHOLDER`;
  const verified = keccak256(toBytes(summary)) as Hex;
  console.log(`[oracle][OI] ${delivered.raw} | PLACEHOLDER verification`);
  return { pass: true, reason: 'OI v1 placeholder: auto-pass', verified };
}

// ── Confirmation window check ─────────────────────────────────
function isPastConfirmationWindow(job: Job, signalType: SignalType): boolean {
  const submitTimeMs = Number(job.submittedAt) * 1000;
  const windowMs     = signalType === 'OI' ? OI_WINDOW_MS : FR_WINDOW_MS;
  return Date.now() >= submitTimeMs + windowMs;
}

// ── Main oracle loop ──────────────────────────────────────────
async function processJobs(): Promise<void> {
  const jobs = await getSubmittedJobs();
  if (jobs.length === 0) {
    console.log('[oracle] no submitted jobs');
    return;
  }

  console.log(`[oracle] ${jobs.length} submitted job(s) to evaluate`);

  for (const job of jobs) {
    // Decode signal from description
    const decoded = decodeDelivery(job.description);
    if (!decoded) {
      console.warn(`[oracle] job #${job.jobId}: unrecognized description format: ${job.description}`);
      continue;
    }

    // Check confirmation window
    if (!isPastConfirmationWindow(job, decoded.type)) {
      const submitTimeMs = Number(job.submittedAt) * 1000;
      const windowMs     = decoded.type === 'OI' ? OI_WINDOW_MS : FR_WINDOW_MS;
      const remainMs     = (submitTimeMs + windowMs) - Date.now();
      console.log(`[oracle] job #${job.jobId}: waiting ${(remainMs / 3600000).toFixed(1)}h for confirmation`);
      continue;
    }

    // Verify signal
    let result: VerifyResult;
    try {
      if (decoded.type === 'FR') {
        result = await verifyFR(decoded);
      } else if (decoded.type === 'OI') {
        result = await verifyOI(decoded);
      } else {
        console.log(`[oracle] job #${job.jobId}: REGIME type — handled by adjudicator`);
        continue;
      }
    } catch (err) {
      console.error(`[oracle] job #${job.jobId}: verification error:`, err);
      continue;
    }

    // Settle
    try {
      if (result.pass) {
        const txHash = await completeJob(job.jobId, result.verified);
        console.log(`[oracle] job #${job.jobId}: COMPLETE ✓ tx=${txHash}`);
        await recordOutcome(job.provider, job.jobId, 'win');
      } else {
        // False attestation: slash
        const txHash = await slashJob(job.jobId);
        console.log(`[oracle] job #${job.jobId}: SLASH ✗ tx=${txHash} reason=${result.reason}`);
        await recordOutcome(job.provider, job.jobId, 'loss');
      }
    } catch (err) {
      console.error(`[oracle] job #${job.jobId}: settlement tx failed:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log('[oracle] Althemis Price Oracle starting');
  console.log(`[oracle] ERC8183=${ERC8183_ADDRESS}`);
  console.log(`[oracle] poll=${POLL_INTERVAL_MS / 60000}min`);

  // Validate env
  if (!ERC8183_ADDRESS) throw new Error('ERC8183_ADDRESS not set');
  if (!process.env.ORACLE_PRIVATE_KEY) throw new Error('ORACLE_PRIVATE_KEY not set');

  // Run immediately then poll
  await processJobs();
  setInterval(processJobs, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('[oracle] fatal:', err);
  process.exit(1);
});
