/**
 * protocol/tier.ts
 * Offchain tier window management.
 * Rules (06-12 design):
 *   Window: 20 jobs (tumbling — evaluated once per 20 jobs, not per job)
 *   Promotion: win_rate >= 60% → Silver, >= 72% → Gold
 *   Demotion:  2 consecutive windows with win_rate < 45% → demote 1 tier
 *
 * Tier affects bond rate (BondHook.getBondRate) and display priority.
 * Oracle calls setProviderTier() on BondHook after each window close.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ProviderTier, setProviderTier } from './escrow.js';
import type { Address } from 'viem';

const TIER_DB_PATH = './data/tiers.json';
const WINDOW_SIZE  = 20;
const PROMOTE_SILVER_RATE = 0.60; // 60%+ win_rate → Silver
const PROMOTE_GOLD_RATE   = 0.72; // 72%+ win_rate → Gold
const DEMOTION_THRESHOLD  = 0.45; // < 45% win_rate = "negative window"
const DEMOTION_CONSECUTIVE = 2;   // 2 consecutive negative windows → demote

// ── Types ─────────────────────────────────────────────────────
type JobOutcome = 'win' | 'loss'; // win = complete, loss = reject

interface ProviderRecord {
  address:   Address;
  tier:      ProviderTier;
  window:    JobOutcome[];   // rolling last 20 (display/inspection only)
  jobsSinceEval: number;     // jobs accumulated since last window close
  negStreak: number;         // consecutive negative (closed) windows
}

type TierDB = Record<string, ProviderRecord>;

// ── DB helpers ────────────────────────────────────────────────
function loadDB(): TierDB {
  if (!existsSync(TIER_DB_PATH)) return {};
  const db = JSON.parse(readFileSync(TIER_DB_PATH, 'utf-8')) as TierDB;
  // Migrate old records that lack jobsSinceEval
  for (const rec of Object.values(db)) {
    if (rec.jobsSinceEval === undefined) {
      rec.jobsSinceEval = rec.window.length % WINDOW_SIZE;
    }
  }
  return db;
}

function saveDB(db: TierDB): void {
  writeFileSync(TIER_DB_PATH, JSON.stringify(db, null, 2));
}

function getOrCreate(db: TierDB, provider: Address): ProviderRecord {
  if (!db[provider]) {
    db[provider] = {
      address:       provider,
      tier:          ProviderTier.Bronze,
      window:        [],
      jobsSinceEval: 0,
      negStreak:     0,
    };
  }
  return db[provider];
}

// ── Core: record outcome + evaluate tier ──────────────────────

/**
 * Record a job outcome. Tier evaluation runs only when a tumbling
 * window closes (every WINDOW_SIZE jobs). Returns new tier if changed.
 */
export async function recordOutcome(
  provider: Address,
  jobId: bigint,
  outcome: JobOutcome,
): Promise<{ tier: ProviderTier; changed: boolean }> {
  const db  = loadDB();
  const rec = getOrCreate(db, provider);

  // Rolling window (display)
  rec.window.push(outcome);
  if (rec.window.length > WINDOW_SIZE) rec.window.shift();

  // Tumbling window counter (evaluation)
  rec.jobsSinceEval++;

  // Window not yet closed → no evaluation
  if (rec.jobsSinceEval < WINDOW_SIZE) {
    saveDB(db);
    return { tier: rec.tier, changed: false };
  }

  // ── Window close: evaluate ──
  rec.jobsSinceEval = 0;

  const wins    = rec.window.filter(o => o === 'win').length;
  const winRate = wins / WINDOW_SIZE;
  const oldTier = rec.tier;
  let newTier   = rec.tier;

  // Promotion logic
  if (winRate >= PROMOTE_GOLD_RATE && rec.tier < ProviderTier.Gold) {
    newTier = ProviderTier.Gold;
  } else if (winRate >= PROMOTE_SILVER_RATE && rec.tier < ProviderTier.Silver) {
    newTier = ProviderTier.Silver;
  }

  // Demotion logic (per closed window)
  if (winRate < DEMOTION_THRESHOLD) {
    rec.negStreak++;
    if (rec.negStreak >= DEMOTION_CONSECUTIVE && rec.tier > ProviderTier.Bronze) {
      newTier = rec.tier - 1 as ProviderTier;
      rec.negStreak = 0; // reset streak after demotion
    }
  } else {
    rec.negStreak = 0;
  }

  const changed = newTier !== oldTier;
  rec.tier = newTier;
  saveDB(db);

  console.log(
    `[tier] window closed for ${provider}: win_rate=${(winRate * 100).toFixed(1)}%` +
    ` negStreak=${rec.negStreak} tier=${ProviderTier[newTier]}${changed ? ` (was ${ProviderTier[oldTier]})` : ''}`
  );

  // Push tier update to BondHook if changed
  if (changed) {
    await setProviderTier(provider, newTier);
  }

  return { tier: newTier, changed };
}

/** Get current tier for a provider (from local DB) */
export function getTier(provider: Address): ProviderTier {
  const db  = loadDB();
  const rec = db[provider];
  return rec?.tier ?? ProviderTier.Bronze;
}

/** Print tier summary for all providers */
export function printTierSummary(): void {
  const db = loadDB();
  const rows = Object.values(db).map(r => ({
    provider:  r.address,
    tier:      ProviderTier[r.tier],
    jobs:      r.window.length,
    sinceEval: r.jobsSinceEval,
    winRate:   r.window.length
      ? `${(r.window.filter(o => o === 'win').length / r.window.length * 100).toFixed(1)}%`
      : 'n/a',
    negStreak: r.negStreak,
  }));
  console.table(rows);
}
