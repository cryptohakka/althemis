/**
 * protocol/roster.config.ts
 * Step 4: roster policy — pure data layer.
 *
 * This file defines WHO participates, WHEN (which rollout phase), and WITH
 * WHAT PARAMETERS (price, fabrication probability). It does NOT contain
 * execution logic — no dice rolls, no submission code, no tier writes.
 * The tick loop (Step 5: protocol/tick.ts or main.js rewrite) reads this
 * config and decides what to actually do each cycle.
 *
 * Invariant (do not violate): tier (Bronze/Silver/Gold) is never assigned
 * here. Tier is an emergent property computed by oracle.ts from on-chain
 * verifiedCount / Wilson lower bound. This file may document *intent* in
 * comments (e.g. "PCHEAP is the Gold-rollup target") but must never become
 * a second write path to tiers.json. The only writer is oracle.ts.
 *
 * Rollout sequencing (confirmed prior session):
 *   Phase 1 — PCHEAP alone. Single provider in the market, CBUYER funds
 *             every job it sees (no preference logic needed). Goal: drive
 *             PCHEAP's verifiedCount to 50 so Gold emerges from job count
 *             alone, with no buyer favoritism and no config nudging it.
 *   Phase 2 — PHONEST / PLIAR / XCHAL join. Multiple providers now compete
 *             for the same CBUYER's funding; job-state single-lock must
 *             already be removed (Step 3 — done) before this phase starts.
 */

import type { RosterRole } from './arc.js';

export type RosterKind = 'provider' | 'consumer' | 'challenger';

export interface RosterPolicy {
  role: RosterRole;
  kind: RosterKind;
  /** Rollout phase this role becomes active in. CBUYER is active in both. */
  phase: 1 | 2;
  /**
   * USDC the provider charges per job (becomes `budget` in setBudget/fundJob).
   * Sub-cent for PCHEAP is intentional — see header: cheapest float cost for
   * the Gold rollup target, not a tier signal.
   * Ignored for consumer/challenger roles (set to 0).
   */
  budgetUSDC: number;
  /**
   * Probability [0,1] that this provider fabricates its FR attestation on
   * a given submission, instead of reporting the real signal. 0 = always
   * honest. Applied by Step 5's tick loop, not here — this is config only.
   * Ignored for consumer/challenger roles (set to 0).
   */
  fabricationProb: number;
  /** Free-text note for humans reading this file. Never read by code. */
  note: string;
}

export const ROSTER_POLICY: Record<RosterRole, RosterPolicy> = {
  PCHEAP: {
    role: 'PCHEAP',
    kind: 'provider',
    phase: 1,
    budgetUSDC: 0.001,
    fabricationProb: 0,
    note: 'Always honest. Sub-cent price = cheapest bond float. Phase 1 solo run drives verifiedCount toward Gold purely via job count — no favoritism, no config-set tier.',
  },
  PHONEST: {
    role: 'PHONEST',
    kind: 'provider',
    phase: 2,
    budgetUSDC: 0.005,
    fabricationProb: 0,
    note: 'Always honest, standard price. Joins in Phase 2 once multiple concurrent jobs are supported (Step 3 prerequisite). Expected to settle around Silver from steady accrual.',
  },
  PLIAR: {
    role: 'PLIAR',
    kind: 'provider',
    phase: 2,
    budgetUSDC: 0.005,
    fabricationProb: 0.15,
    note: 'Standard price, ~15% fabrication rate. Demonstrates operator-adverse slashing: occasional promotion attempts interrupted by Phase A fabrication detection, net settling toward Bronze. The operator (Hakka) loses real bond when this role gets slashed — that is the point.',
  },
  CBUYER: {
    role: 'CBUYER',
    kind: 'consumer',
    phase: 1,
    budgetUSDC: 0,
    fabricationProb: 0,
    note: 'Active from Phase 1 onward. Funds whichever provider(s) are currently in the roster — no preference/round-robin logic needed since Phase 1 has exactly one provider and Phase 2 has no tier-based routing requirement yet.',
  },
  XCHAL: {
    role: 'XCHAL',
    kind: 'challenger',
    phase: 2,
    budgetUSDC: 0,
    fabricationProb: 0,
    note: 'Joins in Phase 2. Sweeps for permissionless-challengeable jobs: expired squatters and post-expiry submissions. Independent slash path, separate from Oracle Phase A/B.',
  },
};

/** All roles active by the given rollout phase (phase 2 includes phase 1's roles). */
export function getActiveRoles(currentPhase: 1 | 2): RosterRole[] {
  return Object.values(ROSTER_POLICY)
    .filter((p) => p.phase <= currentPhase)
    .map((p) => p.role);
}

/** Convenience accessor — throws if role is somehow missing from the table. */
export function getPolicy(role: RosterRole): RosterPolicy {
  const policy = ROSTER_POLICY[role];
  if (!policy) throw new Error(`No roster policy defined for role: ${role}`);
  return policy;
}

/** Provider roles only, restricted to a phase. Useful for tick loops that only care about supply side. */
export function getActiveProviders(currentPhase: 1 | 2): RosterPolicy[] {
  return Object.values(ROSTER_POLICY).filter(
    (p) => p.kind === 'provider' && p.phase <= currentPhase,
  );
}
