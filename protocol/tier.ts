/**
 * protocol/tier.ts
 * Two-axis tier management for Althemis providers.
 *
 *   Reliability (deterministic): Phase A verified count.
 *     Bronze:  0 –  9   verified → 20000 bps (200%)
 *     Silver: 10 – 49   verified → 16000 bps (160%)
 *     Gold:   50+       verified → 12500 bps (125%)
 *     Reset to 0 on Phase A slash (fabrication).
 *
 *   Skill (probabilistic): cumulative Wilson 95% lower bound on Phase B win rate.
 *     Unrated:     n < SKILL_MIN_N (=20)        → discount ×1.00
 *     Calibrated:  n ≥ 20, lcb < 0.50           → discount ×1.00
 *     Edge-S:      lcb ≥ 0.50 (5% hysteresis)   → discount ×0.90  (10% off)
 *     Edge-G:      lcb ≥ 0.60 (5% hysteresis)   → discount ×0.80  (20% off)
 *
 *   Skill demotion (5% hysteresis):
 *     Edge-S → Calibrated when lcb < 0.45
 *     Edge-G → Edge-S     when lcb < 0.55 (or → Calibrated if lcb also < 0.50)
 *
 *   Effective bond rate (basis points):
 *     rateBps = reliabilityBps × skillDiscount / 10000
 *     Math floor: Gold × Edge-G = 12500 × 0.80 = 10000 (100%, BondHook MIN floor).
 *
 *   On-chain push: only when rateBps changes. Existing job locks are immutable
 *   (BondHook stores lockAmt at fund time).
 *
 *   Design principle (memory#16): punishment = deterministic domain (Phase A
 *   slash on fabrication). Reputation splits into reliability (deterministic
 *   verified count, resets on slash) and skill (probabilistic Wilson lower
 *   bound). The Wilson lower bound makes "60% over 20 samples" — which is
 *   inside the binomial noise of a coinflip provider — non-actionable: a
 *   provider only promotes when the lower bound rules out p=0.5.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { setProviderBondRate } from './escrow.js';
import type { Address } from 'viem';

const TIER_DB_PATH = './data/tiers.json';

// ── Reliability tier thresholds (verified count) ────────────
const SILVER_VERIFIED_MIN = 10;
const GOLD_VERIFIED_MIN   = 50;

// ── Reliability rates (basis points) ────────────────────────
const BRONZE_BPS = 20000;
const SILVER_BPS = 16000;
const GOLD_BPS   = 12500;

// ── Skill tier thresholds (Wilson 95% lower bound) ──────────
const SKILL_MIN_N         = 20;
const EDGE_S_PROMOTE_LCB  = 0.50;
const EDGE_S_DEMOTE_LCB   = 0.45;
const EDGE_G_PROMOTE_LCB  = 0.60;
const EDGE_G_DEMOTE_LCB   = 0.55;

// ── Skill discounts (numerator over 10000) ──────────────────
const DISCOUNT_CALIBRATED = 10000; // ×1.00
const DISCOUNT_EDGE_S     =  9000; // ×0.90
const DISCOUNT_EDGE_G     =  8000; // ×0.80
const DISCOUNT_DEN        = 10000;

const WILSON_Z = 1.96;

// ── Types ───────────────────────────────────────────────────
type JobOutcome      = 'win' | 'loss';
type ReliabilityTier = 'Bronze' | 'Silver' | 'Gold';
type SkillTier       = 'Unrated' | 'Calibrated' | 'Edge-S' | 'Edge-G';

interface ProviderRecord {
  address:         Address;
  // Reliability axis: Phase A verified count (resets on fabrication slash)
  verifiedCount:   number;
  // Skill axis: cumulative Phase B win/loss (no-contest excluded by oracle)
  cumWins:         number;
  cumLosses:       number;
  // Rolling last-20 window: display only, not used for tier math
  window:          JobOutcome[];
  // Derived (cached for inspection and to detect changes)
  reliabilityTier: ReliabilityTier;
  skillTier:       SkillTier;
  bondRateBps:     number;
}

type TierDB = Record<string, ProviderRecord>;

// ── DB ──────────────────────────────────────────────────────
function loadDB(): TierDB {
  if (!existsSync(TIER_DB_PATH)) return {};
  const db = JSON.parse(readFileSync(TIER_DB_PATH, 'utf-8')) as TierDB;
  // Migration from the old single-axis schema (jobsSinceEval/negStreak/tier enum)
  for (const rec of Object.values(db)) {
    if (rec.verifiedCount === undefined)   rec.verifiedCount   = 0;
    if (rec.cumWins === undefined) {
      const w = rec.window?.filter(o => o === 'win').length ?? 0;
      rec.cumWins   = w;
      rec.cumLosses = (rec.window?.length ?? 0) - w;
    }
    if (rec.window === undefined)          rec.window          = [];
    if (rec.reliabilityTier === undefined) rec.reliabilityTier = 'Bronze';
    if (rec.skillTier === undefined)       rec.skillTier       = 'Unrated';
    if (rec.bondRateBps === undefined)     rec.bondRateBps     = BRONZE_BPS;
  }
  return db;
}

function saveDB(db: TierDB): void {
  mkdirSync('./data', { recursive: true });
  writeFileSync(TIER_DB_PATH, JSON.stringify(db, null, 2));
}

function getOrCreate(db: TierDB, provider: Address): ProviderRecord {
  if (!db[provider]) {
    db[provider] = {
      address:         provider,
      verifiedCount:   0,
      cumWins:         0,
      cumLosses:       0,
      window:          [],
      reliabilityTier: 'Bronze',
      skillTier:       'Unrated',
      bondRateBps:     BRONZE_BPS,
    };
  }
  return db[provider];
}

// ── Wilson 95% lower bound ──────────────────────────────────
/**
 * Wilson score interval, lower bound, z = 1.96 (95% confidence).
 * Returns 0 for n = 0. Clamped to [0, 1].
 */
export function wilsonLower(wins: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const denom  = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  const lb = (center - margin) / denom;
  if (lb < 0) return 0;
  if (lb > 1) return 1;
  return lb;
}

// ── Tier derivation ─────────────────────────────────────────
function deriveReliabilityTier(n: number): ReliabilityTier {
  if (n >= GOLD_VERIFIED_MIN)   return 'Gold';
  if (n >= SILVER_VERIFIED_MIN) return 'Silver';
  return 'Bronze';
}

function reliabilityBps(t: ReliabilityTier): number {
  switch (t) {
    case 'Gold':   return GOLD_BPS;
    case 'Silver': return SILVER_BPS;
    default:       return BRONZE_BPS;
  }
}

/**
 * Skill tier with 5% hysteresis. `current` is required so demotion uses the
 * looser threshold (lcb < 0.45 for Edge-S, lcb < 0.55 for Edge-G). New
 * providers graduate from Unrated → Calibrated at n = SKILL_MIN_N.
 */
function deriveSkillTier(wins: number, losses: number, current: SkillTier): SkillTier {
  const n = wins + losses;
  if (n < SKILL_MIN_N) return 'Unrated';
  const lcb = wilsonLower(wins, n);

  // Demotion paths take precedence (hysteresis-driven)
  if (current === 'Edge-G' && lcb < EDGE_G_DEMOTE_LCB) {
    return lcb >= EDGE_S_PROMOTE_LCB ? 'Edge-S' : 'Calibrated';
  }
  if (current === 'Edge-S' && lcb < EDGE_S_DEMOTE_LCB) {
    return 'Calibrated';
  }

  // Promotion paths
  if (lcb >= EDGE_G_PROMOTE_LCB) return 'Edge-G';
  if (lcb >= EDGE_S_PROMOTE_LCB) return 'Edge-S';

  // Stay where we are if nothing triggers; Unrated graduates at n ≥ 20.
  return current === 'Unrated' ? 'Calibrated' : current;
}

function skillDiscountNum(t: SkillTier): number {
  switch (t) {
    case 'Edge-G': return DISCOUNT_EDGE_G;
    case 'Edge-S': return DISCOUNT_EDGE_S;
    default:       return DISCOUNT_CALIBRATED;
  }
}

function computeBondRateBps(r: ReliabilityTier, s: SkillTier): number {
  return Math.round((reliabilityBps(r) * skillDiscountNum(s)) / DISCOUNT_DEN);
}

// ── Recompute + push on change ──────────────────────────────
async function recomputeAndPush(rec: ProviderRecord): Promise<boolean> {
  const r = deriveReliabilityTier(rec.verifiedCount);
  const s = deriveSkillTier(rec.cumWins, rec.cumLosses, rec.skillTier);
  const bps = computeBondRateBps(r, s);

  const tierChanged = r !== rec.reliabilityTier || s !== rec.skillTier;
  const bpsChanged  = bps !== rec.bondRateBps;

  rec.reliabilityTier = r;
  rec.skillTier       = s;

  if (bpsChanged) {
    try {
      await setProviderBondRate(rec.address, BigInt(bps));
      rec.bondRateBps = bps;
    } catch (err) {
      console.error(`[tier] setProviderBondRate failed for ${rec.address}:`, err);
      // Local cache bondRateBps unchanged → next event will retry the push.
      return tierChanged;
    }
  }
  return tierChanged || bpsChanged;
}

// ── Public API ──────────────────────────────────────────────

/** Phase A: attestation verified. +1 to reliability count. */
export async function recordVerified(provider: Address): Promise<void> {
  const db = loadDB();
  const rec = getOrCreate(db, provider);
  rec.verifiedCount++;
  const changed = await recomputeAndPush(rec);
  saveDB(db);
  console.log(
    `[tier] ${provider}: verified+1 → count=${rec.verifiedCount} ` +
    `rel=${rec.reliabilityTier} skill=${rec.skillTier} bps=${rec.bondRateBps}` +
    (changed ? ' (changed)' : '')
  );
}

/** Phase A: fabrication slash. Reset reliability to 0. Skill untouched. */
export async function recordSlash(provider: Address): Promise<void> {
  const db = loadDB();
  const rec = getOrCreate(db, provider);
  rec.verifiedCount = 0;
  const changed = await recomputeAndPush(rec);
  saveDB(db);
  console.log(
    `[tier] ${provider}: SLASH → verifiedCount=0 ` +
    `rel=${rec.reliabilityTier} skill=${rec.skillTier} bps=${rec.bondRateBps}` +
    (changed ? ' (changed)' : '')
  );
}

/** Phase B: prediction settled. Updates skill axis only. */
export async function recordOutcome(
  provider: Address,
  jobId: bigint,
  outcome: JobOutcome,
): Promise<{ tier: SkillTier; changed: boolean }> {
  const db = loadDB();
  const rec = getOrCreate(db, provider);

  if (outcome === 'win') rec.cumWins++;
  else                   rec.cumLosses++;

  rec.window.push(outcome);
  if (rec.window.length > 20) rec.window.shift();

  const changed = await recomputeAndPush(rec);
  saveDB(db);

  const n = rec.cumWins + rec.cumLosses;
  const lcb = wilsonLower(rec.cumWins, n);
  console.log(
    `[tier] ${provider}: job#${jobId} ${outcome} ` +
    `cum=${rec.cumWins}/${n} lcb=${lcb.toFixed(3)} ` +
    `rel=${rec.reliabilityTier} skill=${rec.skillTier} bps=${rec.bondRateBps}` +
    (changed ? ' (changed)' : '')
  );
  return { tier: rec.skillTier, changed };
}

/** Current effective bond rate (bps) for display / sanity-check */
export function getBondRateBps(provider: Address): number {
  const db = loadDB();
  return db[provider]?.bondRateBps ?? BRONZE_BPS;
}

/** Print full tier summary for all known providers */
export function printTierSummary(): void {
  const db = loadDB();
  const rows = Object.values(db).map(r => {
    const n = r.cumWins + r.cumLosses;
    return {
      provider:    r.address,
      reliability: r.reliabilityTier,
      verified:    r.verifiedCount,
      skill:       r.skillTier,
      n,
      win_rate:    n > 0 ? `${((r.cumWins / n) * 100).toFixed(1)}%` : 'n/a',
      lcb:         n > 0 ? wilsonLower(r.cumWins, n).toFixed(3) : 'n/a',
      bond_rate:   `${(r.bondRateBps / 100).toFixed(2)}%`,
    };
  });
  console.table(rows);
}
