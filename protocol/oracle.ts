/**
 * protocol/oracle.ts
 * Price Oracle — ERC-8183 evaluator for Althemis signal marketplace
 *
 * Two-phase design (principle: punishment is deterministic, reputation is probabilistic):
 *
 *   Phase A — ATTESTATION (immediate, deterministic):
 *     On detecting a freshly Submitted job, verify the attested value against
 *     live 6-CEX median. Fabrication → 100% slash + reliability reset.
 *     Verification failure (quorum, API errors) NEVER slashes — it retries,
 *     and if the freshness window expires, the job is marked unverifiable:
 *     no slash, no tier impact.
 *
 *   Phase B — PREDICTION (N-hour, probabilistic, tier only):
 *     After the signal window (FR=8h, OI=4h), score the provider's
 *     DIRECTIONAL claim (dir=long/short from their z-score model).
 *     Provider is paid (complete) regardless of outcome — payment rewards
 *     honest delivery, skill tier tracks ability.
 *       - dir=neutral or legacy format (no dir) → no claim → not scored
 *       - |realized - attested| <= 0.5 × MAD    → no-contest, not scored
 *         (no-contest does NOT consume a tumbling-window slot, so
 *          band-hugging is not a viable tier strategy)
 *       - dir=short: realized < attested - band → win, else loss
 *       - dir=long:  realized > attested + band → win, else loss
 *
 *   Fabrication threshold is deliberately GENEROUS: max(3 × MAD, floor).
 *   Only values no exchange printed get slashed. z/dir are the provider's
 *   interpretation — scored, never slashed.
 *
 *   REGIME signals: no bond, adjudicator-settled. Skipped here.
 *   OI: per-CEX OI verification not yet implemented — jobs held, never
 *   auto-passed (a placeholder pass would silently break the deterministic layer).
 *
 *   CONF (dual-tier x402 commissioning, PCONF role only):
 *     On-chain description carries a commit-hash, not the raw value.
 *     The raw value is relayed privately (confidential-relay.ts) by the
 *     commissioning server at job-creation time. Phase A verifies the
 *     hash, then runs the IDENTICAL Phase A fabrication check against the
 *     revealed value — tier selection changes WHO can see the value, never
 *     WHAT the oracle punishes. The raw value becomes public again at
 *     Phase B settlement (embargo model), since settleFRPrediction's
 *     `detail` always carries attested/realized values into logEvent.
 *     PCONF is never in ROSTER_POLICY / getActiveRoles — this oracle loop
 *     is the only place that ever touches CONF jobs.
 *
 *   Tier integration (tier.ts):
 *     Phase A verified → recordVerified(provider) (+1 reliability count)
 *     Phase A slash    → recordSlash(provider)    (reset reliability to 0)
 *     Phase B win/loss → recordOutcome(provider, jobId, kind) (skill axis)
 *     no_contest       → NOT recorded (window-neutral)
 *     unverifiable     → NOT recorded (no tier impact, paid out via complete)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { keccak256, toBytes, type Address, type Hex } from 'viem';
import {
  getSubmittedJobs, completeJob, slashJob,
  ERC8183_ADDRESS,
  type Job,
} from './escrow.js';
import { recordOutcome, recordVerified, recordSlash } from './tier.js';
import { getRelay, deleteRelay, computeCommitHash } from './confidential-relay.js';
import { processConditionalJobs } from './conditional.js';

// ── Config ────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

// Phase B confirmation windows (ms)
const FR_WINDOW_MS = 8 * 60 * 60 * 1000; // 8h
const OI_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h

// Phase A: attestation must be verified while the fact is still live.
const ATTESTATION_FRESHNESS_MS = 15 * 60 * 1000; // 15 min

// Phase A: fabrication threshold (GENEROUS — slash only what no CEX printed)
const FABRICATION_MAD_MULTIPLIER = 3;        // max(3 × MAD, floor)
const FR_FABRICATION_FLOOR = 0.0001;         // 0.01% absolute FR floor
const MIN_CEX_QUORUM = 4;                    // of 6 — below this, retry, never slash

// Phase B: no-contest band (tier scoring only)
const FR_NO_CONTEST_MAD_MULTIPLIER = 0.5;    // |realized - attested| < 0.5 × MAD
const OI_NO_CONTEST_PCT = 0.003;             // 0.3% absolute

// ── Signal types ──────────────────────────────────────────────
type SignalType = 'FR' | 'OI' | 'REGIME';
type Direction  = 'long' | 'short' | 'neutral';

interface DeliveryDecoded {
  type:   SignalType;
  asset:  string;
  window: string;
  value:  number;
  z:      number | null;       // provider interpretation (scored, never slashed)
  dir:    Direction | null;    // directional claim. null = legacy format
  raw:    string;
}

function decodeDelivery(description: string): DeliveryDecoded | null {
  const match = description.match(
    /^(FR|OI|REGIME)_([A-Z]+)_(\d+h)=(-?[\d.]+)(?:;z=(-?[\d.]+))?(?:;dir=(long|short|neutral))?$/
  );
  if (!match) return null;
  return {
    type:   match[1] as SignalType,
    asset:  match[2],
    window: match[3],
    value:  parseFloat(match[4]),
    z:      match[5] !== undefined ? parseFloat(match[5]) : null,
    dir:    (match[6] as Direction | undefined) ?? null,
    raw:    description,
  };
}

// CONF format: CONF_<ASSET>_<window>=<commit-hash>. Raw value is NOT here —
// it lives only in confidential-relay.ts until Phase A verifies the hash.
const CONF_RE = /^CONF_([A-Z]+)_(\d+h)=(0x[0-9a-fA-F]{64})$/;
interface ConfDecoded { asset: string; window: string; commitHash: Hex }
function decodeConfidential(description: string): ConfDecoded | null {
  const m = description.match(CONF_RE);
  if (!m) return null;
  return { asset: m[1], window: m[2], commitHash: m[3] as Hex };
}

// ── Oracle state (data/oracle_state.json) ─────────────────────
type AttestationStatus = 'verified' | 'unverifiable';

interface JobOracleState {
  jobId:          string;
  provider:       Address;
  signal:         string;
  attestation:    AttestationStatus;
  attestedValue:  number;
  medianAtAttest: number | null;
  madAtAttest:    number | null;
  settleAtMs:     number;
}

const ORACLE_STATE_PATH = './data/oracle_state.json';
type OracleStateDB = Record<string, JobOracleState>;

function loadState(): OracleStateDB {
  if (!existsSync(ORACLE_STATE_PATH)) return {};
  return JSON.parse(readFileSync(ORACLE_STATE_PATH, 'utf-8')) as OracleStateDB;
}

function saveState(db: OracleStateDB): void {
  mkdirSync('./data', { recursive: true });
  writeFileSync(ORACLE_STATE_PATH, JSON.stringify(db, null, 2));
}

// Append-only event ledger - durable, journald-independent record of every
// terminal oracle decision. One JSON object per line. Consumed by
// tools/oracle_metrics.py (--events ./data/events.jsonl).
const EVENTS_PATH = './data/events.jsonl';

// Monotonic event id. Restored from the last line of events.jsonl at startup,
// then ++ per logEvent. Single oracle process (systemd, no multi-instance) →
// strictly increasing, no races. eventId is the dashboard's display sort key:
// job history sorts by eventId desc, so a late Phase-B settle of an old jobId
// no longer jumps above newer jobs — row order = record order, while jobId
// stays the (intentionally sparse) on-chain identifier.
let eventCounter = 0;
function initEventCounter(): void {
  try {
    const txt = readFileSync(EVENTS_PATH, 'utf-8').trimEnd();
    if (!txt) { eventCounter = 0; return; }
    const lines = txt.split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    eventCounter = typeof last.eventId === 'number' ? last.eventId : lines.length;
  } catch { eventCounter = 0; }
}
function logEvent(e: {
  phase: 'A' | 'B';
  jobId: string;
  outcome: string;            // verified | unverifiable | slashed | win | loss | no_contest
  tx?: string | null;
  detail?: string;
  confidential?: boolean;     // true for CONF-tier jobs (dual-tier x402 commissioning)
}): void {
  try {
    mkdirSync('./data', { recursive: true });
    const eventId = ++eventCounter;
    appendFileSync(EVENTS_PATH, JSON.stringify({ eventId, ts: new Date().toISOString(), ...e }) + '\n');
  } catch (err) {
    console.error('[oracle] event ledger append failed:', err);
  }
}

// ── 6-CEX data fetching ───────────────────────────────────────
// NOTE: all endpoints return the LAST SETTLED funding rate (not predicted),
// so the median compares like with like.

interface CexFrData {
  exchange: string;
  rate: number;
}

export async function fetch6CexFR(asset: string): Promise<CexFrData[]> {
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
        `https://www.okx.com/api/v5/public/funding-rate-history?instId=${asset}-USDT-SWAP&limit=1`
      );
      const d = await r.json() as any;
      return d?.data?.[0] ? parseFloat(d.data[0].fundingRate) : null;
    }],
    ['Bitget', async () => {
      const r = await fetch(
        `https://api.bitget.com/api/v2/mix/market/history-fund-rate?symbol=${symbol}&productType=USDT-FUTURES&pageSize=1`
      );
      const d = await r.json() as any;
      return d?.data?.[0] ? parseFloat(d.data[0].fundingRate) : null;
    }],
    ['Gate', async () => {
      const r = await fetch(
        `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${asset}_USDT&limit=1`
      );
      const d = await r.json() as any[];
      return d?.[0]?.r ? parseFloat(d[0].r) : null;
    }],
    ['MEXC', async () => {
      const r = await fetch(
        `https://contract.mexc.com/api/v1/contract/funding_rate/${asset}_USDT`
      );
      const d = await r.json() as any;
      return d?.data?.fundingRate !== undefined ? parseFloat(d.data.fundingRate) : null;
    }],
  ];

  await Promise.allSettled(
    fetchers.map(async ([name, fn]) => {
      try {
        const rate = await fn();
        if (rate !== null && Number.isFinite(rate)) results.push({ exchange: name, rate });
      } catch { /* skip failed exchange */ }
    })
  );

  return results;
}

/** Compute median and MAD (Median Absolute Deviation) */
export function medianMad(values: number[]): { median: number; mad: number } {
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

// ── Phase A: attestation verification ─────────────────────────

type AttestOutcome =
  | { kind: 'pass'; median: number; mad: number }
  | { kind: 'fabricated'; median: number; mad: number; diff: number; threshold: number }
  | { kind: 'retry'; reason: string };   // quorum/API failure — never slash

async function attestFR(decoded: DeliveryDecoded): Promise<AttestOutcome> {
  const cexData = await fetch6CexFR(decoded.asset);
  if (cexData.length < MIN_CEX_QUORUM) {
    return { kind: 'retry', reason: `quorum ${cexData.length}/${MIN_CEX_QUORUM}` };
  }

  const { median, mad } = medianMad(cexData.map(d => d.rate));
  const diff      = Math.abs(decoded.value - median);
  const threshold = Math.max(mad * FABRICATION_MAD_MULTIPLIER, FR_FABRICATION_FLOOR);

  console.log(
    `[oracle][attest][FR] ${decoded.raw} | median=${median.toFixed(6)} mad=${mad.toFixed(6)} ` +
    `diff=${diff.toFixed(6)} threshold=${threshold.toFixed(6)} ` +
    `exchanges=${cexData.map(d => d.exchange).join(',')}`
  );

  if (diff > threshold) {
    return { kind: 'fabricated', median, mad, diff, threshold };
  }
  return { kind: 'pass', median, mad };
}

// ── Phase B: prediction settlement ────────────────────────────

type PredictOutcome =
  | { kind: 'win' | 'loss'; detail: string }
  | { kind: 'no_contest'; detail: string }   // excluded from tier window
  | { kind: 'retry'; reason: string };

/**
 * FR prediction rule (directional):
 *   dir=short → claims FR will fall: realized < attested - band → win
 *   dir=long  → claims FR will rise: realized > attested + band → win
 *   dir=neutral / legacy (no dir)   → no claim → not scored
 *   |realized - attested| <= band   → no-contest
 */
async function settleFRPrediction(
  decoded: DeliveryDecoded,
  state: JobOracleState,
): Promise<PredictOutcome> {
  if (!decoded.dir || decoded.dir === 'neutral') {
    return { kind: 'no_contest', detail: 'no directional claim' };
  }

  const cexData = await fetch6CexFR(decoded.asset);
  if (cexData.length < MIN_CEX_QUORUM) {
    return { kind: 'retry', reason: `quorum ${cexData.length}/${MIN_CEX_QUORUM}` };
  }

  const { median: realized, mad } = medianMad(cexData.map(d => d.rate));
  const attested = state.attestedValue;
  const band     = mad * FR_NO_CONTEST_MAD_MULTIPLIER;
  const moved    = realized - attested;

  const detail =
    `dir=${decoded.dir} attested=${attested.toFixed(6)} realized=${realized.toFixed(6)} ` +
    `moved=${moved.toFixed(6)} band=${band.toFixed(6)}`;

  if (Math.abs(moved) <= band) return { kind: 'no_contest', detail };

  const correct = decoded.dir === 'short' ? moved < 0 : moved > 0;
  return { kind: correct ? 'win' : 'loss', detail };
}

// ── Window helpers ────────────────────────────────────────────
function windowMsFor(type: SignalType): number {
  return type === 'OI' ? OI_WINDOW_MS : FR_WINDOW_MS;
}

// ── Main oracle loop ──────────────────────────────────────────
async function processJobs(): Promise<void> {
  const jobs = await getSubmittedJobs();
  if (jobs.length === 0) {
    console.log('[oracle] no submitted jobs');
    return;
  }

  console.log(`[oracle] ${jobs.length} submitted job(s)`);
  const state = loadState();

  for (const job of jobs) {
    const key = job.jobId.toString();
    const submitTimeMs = Number(job.submittedAt) * 1000;
    const ageMs = Date.now() - submitTimeMs;

    // ── Decode: plain signal format (unchanged path), or CONF dual-tier ──
    // x402 commissioning format. Plain path below is byte-for-byte identical
    // to the pre-CONF implementation — CONF is a pure addition, never taken
    // unless decodeDelivery() returns null.
    let decoded: DeliveryDecoded;
    let isConfidential = false;

    const plainDecoded = decodeDelivery(job.description);
    if (plainDecoded) {
      decoded = plainDecoded;
    } else {
      const conf = decodeConfidential(job.description);
      if (!conf) {
        console.warn(`[oracle] job #${job.jobId}: unrecognized description: ${job.description}`);
        continue;
      }
      isConfidential = true;

      if (state[key]) {
        // Already attested in a prior cycle (now in Phase B) — reuse stored value,
        // no relay lookup needed (relay was already deleted at Phase A resolution).
        decoded = {
          type: 'FR', asset: conf.asset, window: conf.window,
          value: state[key].attestedValue, z: null, dir: null, raw: job.description,
        };
      } else {
        const relay = getRelay(key);
        if (!relay) {
          console.log(`[oracle] job #${key}: CONF job awaiting relay entry, retrying next poll`);
          continue; // commissioning server may not have written it yet — never slash on this
        }
        const expectHash = computeCommitHash(relay.value, relay.nonce);
        if (expectHash.toLowerCase() !== conf.commitHash.toLowerCase()) {
          console.warn(`[oracle] job #${key}: CONF commit hash mismatch — treating as fabricated`);
          try {
            const txHash = await slashJob(job.jobId);
            logEvent({ phase: 'A', jobId: key, outcome: 'slashed', tx: txHash,
                       detail: 'CONF commit hash mismatch', confidential: true });
            await recordSlash(job.provider);
          } catch (err) {
            console.error(`[oracle] job #${key}: slash tx failed:`, err);
          }
          deleteRelay(key);
          continue;
        }
        decoded = {
          type: 'FR', asset: relay.asset, window: relay.window,
          value: relay.value, z: null, dir: null, raw: job.description,
        };
      }
    }

    if (decoded.type === 'REGIME') {
      console.log(`[oracle] job #${job.jobId}: REGIME — adjudicator-settled, skipping`);
      continue;
    }
    if (decoded.type === 'OI') {
      console.log(`[oracle] job #${job.jobId}: OI — verification not implemented, holding`);
      continue;
    }

    // ── Phase A: attestation (only once, while fresh) ──
    if (!state[key]) {
      if (ageMs <= ATTESTATION_FRESHNESS_MS) {
        const result = await attestFR(decoded);

        if (result.kind === 'retry') {
          console.log(`[oracle] job #${key}: attestation retry (${result.reason})`);
          continue; // NEVER slash on verification failure
        }

        if (result.kind === 'fabricated') {
          try {
            const txHash = await slashJob(job.jobId);
            console.log(
              `[oracle] job #${key}: SLASH ✗ fabricated attestation ` +
              `diff=${result.diff.toFixed(6)} > threshold=${result.threshold.toFixed(6)} tx=${txHash}`
            );
            logEvent({ phase: 'A', jobId: key, outcome: 'slashed', tx: txHash,
                       detail: `diff=${result.diff.toFixed(6)} threshold=${result.threshold.toFixed(6)}`,
                       ...(isConfidential ? { confidential: true } : {}) });
            // Reliability axis: reset verifiedCount to 0 (deterministic punishment).
            // Skill axis is independent — fabrication does not retroactively affect Phase B history.
            await recordSlash(job.provider);
          } catch (err) {
            console.error(`[oracle] job #${key}: slash tx failed:`, err);
          }
          if (isConfidential) deleteRelay(key);
          continue;
        }

        // pass
        state[key] = {
          jobId: key,
          provider: job.provider,
          signal: decoded.raw,
          attestation: 'verified',
          attestedValue: decoded.value,
          medianAtAttest: result.median,
          madAtAttest: result.mad,
          settleAtMs: submitTimeMs + windowMsFor(decoded.type),
        };
        saveState(state);
        console.log(`[oracle] job #${key}: attestation VERIFIED, settles in ${(windowMsFor(decoded.type) / 3600000).toFixed(0)}h`);
        logEvent({ phase: 'A', jobId: key, outcome: 'verified', detail: decoded.raw,
                   ...(isConfidential ? { confidential: true } : {}) });
        // Reliability axis: +1 to verified count (deterministic reward for honest attestation).
        await recordVerified(job.provider);
        if (isConfidential) deleteRelay(key);
        continue;
      } else {
        // Missed the freshness window (oracle downtime). Fail-safe:
        // cannot prove fabrication against live data → no slash, no tier impact.
        state[key] = {
          jobId: key,
          provider: job.provider,
          signal: decoded.raw,
          attestation: 'unverifiable',
          attestedValue: decoded.value,
          medianAtAttest: null,
          madAtAttest: null,
          settleAtMs: submitTimeMs + windowMsFor(decoded.type),
        };
        saveState(state);
        console.warn(`[oracle] job #${key}: attestation UNVERIFIABLE (age ${(ageMs / 60000).toFixed(0)}min) — will settle without tier impact`);
        if (isConfidential) deleteRelay(key);
        continue;
      }
    }

    // ── Phase B: prediction settlement ──
    const js = state[key];
    if (Date.now() < js.settleAtMs) {
      const remainH = (js.settleAtMs - Date.now()) / 3600000;
      console.log(`[oracle] job #${key}: waiting ${remainH.toFixed(1)}h for settlement`);
      continue;
    }

    // Unverifiable attestation: complete (pay), no tier impact.
    if (js.attestation === 'unverifiable') {
      try {
        const reason = keccak256(toBytes(`SETTLE:unverifiable:${js.signal}`)) as Hex;
        const txHash = await completeJob(job.jobId, reason);
        console.log(`[oracle] job #${key}: COMPLETE (unverifiable, no tier impact) tx=${txHash}`);
        logEvent({ phase: 'A', jobId: key, outcome: 'unverifiable', tx: txHash,
                   ...(isConfidential ? { confidential: true } : {}) });
        delete state[key];
        saveState(state);
      } catch (err) {
        console.error(`[oracle] job #${key}: complete tx failed:`, err);
      }
      continue;
    }

    let outcome: PredictOutcome;
    try {
      outcome = await settleFRPrediction(decoded, js);
    } catch (err) {
      console.error(`[oracle] job #${key}: prediction settlement error:`, err);
      continue;
    }
    if (outcome.kind === 'retry') {
      console.log(`[oracle] job #${key}: settlement retry (${outcome.reason})`);
      continue;
    }

    // Honest provider → always paid. Tier (skill axis) reflects ability.
    try {
      const reason = keccak256(toBytes(`SETTLE:${outcome.kind}:${outcome.detail}`)) as Hex;
      const txHash = await completeJob(job.jobId, reason);
      console.log(`[oracle] job #${key}: COMPLETE (${outcome.kind}) ${outcome.detail} tx=${txHash}`);
      // NOTE: outcome.detail carries attested+realized values — this IS the
      // Phase B reveal for CONF jobs (embargo model: hidden at Phase A, public here).
      logEvent({ phase: 'B', jobId: key, outcome: outcome.kind, tx: txHash, detail: outcome.detail,
                 ...(isConfidential ? { confidential: true } : {}) });

      if (outcome.kind === 'win' || outcome.kind === 'loss') {
        await recordOutcome(job.provider, job.jobId, outcome.kind);
      }
      // no_contest: NOT recorded — does not consume a tumbling-window slot.

      delete state[key];
      saveState(state);
    } catch (err) {
      console.error(`[oracle] job #${key}: settlement tx failed:`, err);
    }
  }
}

async function main(): Promise<void> {
  console.log('[oracle] Althemis Price Oracle starting (two-phase, two-axis tier)');
  initEventCounter();
  console.log(`[oracle] event counter initialized at ${eventCounter}`);
  console.log(`[oracle] ERC8183=${ERC8183_ADDRESS}`);
  console.log(`[oracle] poll=${POLL_INTERVAL_MS / 60000}min, attestation freshness=${ATTESTATION_FRESHNESS_MS / 60000}min`);
  console.log(`[oracle] fabrication=max(${FABRICATION_MAD_MULTIPLIER}×MAD, ${FR_FABRICATION_FLOOR}), no-contest=${FR_NO_CONTEST_MAD_MULTIPLIER}×MAD, quorum=${MIN_CEX_QUORUM}/6`);

  if (!ERC8183_ADDRESS) throw new Error('ERC8183_ADDRESS not set');
  if (!process.env.ORACLE_PRIVATE_KEY) throw new Error('ORACLE_PRIVATE_KEY not set');

  await processJobs();
  await processConditionalJobs();
  setInterval(async () => {
    await processJobs();
    await processConditionalJobs();
  }, POLL_INTERVAL_MS);
}

main().catch(err => {
  console.error('[oracle] fatal:', err);
  process.exit(1);
});
