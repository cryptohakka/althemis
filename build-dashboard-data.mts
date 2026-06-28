import fs from 'fs';
import { ROSTER_POLICY } from './protocol/roster.config.js';
import { getJob } from './protocol/escrow.js';

const ROLE_NAMES: Record<string, string> = {
  '0xbEc3bCcf463b62E456a062195a6708840C78a1Ab': 'PCHEAP',
  '0xBe57D502dD6Ac3824E6869555e50085d79453313': 'PHONEST',
  '0x1D58AF58145E56d508A448aEf65D5F2797aBe874': 'PLIAR',
  '0xF7e8ff5485330Ff4dBd69E807b66818Caa6085c7': 'PCONF',
};

const BUDGET_BY_NAME: Record<string, number> = {
  PCHEAP:  ROSTER_POLICY.PCHEAP.budgetUSDC,
  PHONEST: ROSTER_POLICY.PHONEST.budgetUSDC,
  PLIAR:   ROSTER_POLICY.PLIAR.budgetUSDC,
  // PCONF is outside roster.config.ts by design (commissioning-only, not
  // part of the autonomous tick roster) — its price comes from
  // commission-server.ts's PCONF_PRICE_OPEN_USD env, $0.01 by default.
  PCONF: parseFloat((process.env.PCONF_PRICE_OPEN_USD || '$0.01').replace('$', '')),
};

const tiers = JSON.parse(fs.readFileSync('data/tiers.json', 'utf8'));
const oracleState = JSON.parse(fs.readFileSync('data/oracle_state.json', 'utf8'));
// Provider commissioning type — chosen at registration. 'open' publishes the
// raw value on-chain immediately; 'confidential' publishes only a commit-hash
// and reveals at Phase B settlement. PCONF is the first confidential-type provider.
const COMMISSION_TYPE: Record<string, 'open' | 'confidential'> = {
  PCHEAP: 'open',
  PHONEST: 'open',
  PLIAR: 'open',
  PCONF: 'confidential',
};
// Signal type per provider (registration-time property, like commissionType).
// All current providers report funding-rate (FR). OI, regime, and private
// feeds sit on the roadmap along the reproduction-cost gradient — see README.
const SIGNAL_TYPE: Record<string, 'FR' | 'OI' | 'REGIME'> = {
  PCHEAP: 'FR',
  PHONEST: 'FR',
  PLIAR: 'FR',
  PCONF: 'FR',
};

const events = fs.readFileSync('data/events.jsonl', 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const providers = Object.values(tiers as Record<string, any>)
  .filter((t: any) => ROLE_NAMES[t.address])
  .map((t: any) => {
    const name = ROLE_NAMES[t.address];
    return {
      name,
      address: t.address,
      reliabilityTier: t.reliabilityTier,
      verifiedCount: t.verifiedCount,
      skillTier: t.skillTier,
      cumWins: t.cumWins,
      cumLosses: t.cumLosses,
      bondRateBps: t.bondRateBps,
      budgetUSDC: BUDGET_BY_NAME[name] ?? 0.001,
      commissionType: COMMISSION_TYPE[name] ?? 'open',
      signalType: SIGNAL_TYPE[name] ?? 'FR',
    };
  })
  .sort((a, b) => b.verifiedCount - a.verifiedCount);

const RECENT_N = 200;
const recentEvents = [...events]
  .filter(e => e.outcome !== 'no_contest' && e.outcome !== 'unverifiable')
  .sort((a, b) => (b.eventId ?? 0) - (a.eventId ?? 0))
  .slice(0, RECENT_N);

const jobs = [];
for (const e of recentEvents) {
  const st = oracleState[e.jobId];
  let providerAddr = st?.provider;

  // Slashed (and some other terminal) jobs are removed from oracle_state.json
  // once settled — fall back to an on-chain read so the dashboard never shows
  // a blank provider for a real, on-chain-confirmed slash.
  let clientAddr = null;
  // client (buyer) address is never in oracle_state.json, so it always
  // requires an on-chain getJob read; reuse it for provider fallback too.
  try {
    const job = await getJob(BigInt(e.jobId));
    if (!providerAddr) providerAddr = job.provider;
    clientAddr = job.client;
  } catch {
    if (!providerAddr) providerAddr = null;
  }

  jobs.push({
    eventId: e.eventId,
    jobId: e.jobId,
    ts: e.ts,
    phase: e.phase,
    outcome: e.outcome,
    detail: e.detail,
    tx: e.tx ?? null,
    provider: providerAddr ? (ROLE_NAMES[providerAddr] ?? providerAddr) : null,
    client: clientAddr,
  });
}

const totalSlashes = events.filter(e => e.outcome === 'slashed').length;
const totalEvents = Math.max(0, ...events.map(e => e.eventId ?? 0));
const totalJobs = Math.max(...events.map(e => parseInt(e.jobId, 10))); // latest on-chain job number (BondHook sequential id)
const latestSlash = events.filter(e => e.outcome === 'slashed').slice(-1)[0] ?? null;

// ── Conditional contracts (separate escrow, separate state file) ──────
// Predictions sold as conditional contracts, not graded forecasts — the
// deterministic successor to the abandoned probabilistic Phase B. A
// Provider declares a verifiable threshold; outcome is read from public
// data at the deadline (released/refunded), never scored as predictive skill.
const ASSET_NAMES: Record<number, string> = { 0: 'BTC' };
const OP_NAMES: Record<number, string> = { 0: 'GTE', 1: 'LTE' };
let conditionalJobs: any[] = [];
try {
  const condState = JSON.parse(fs.readFileSync('data/conditional_state.json', 'utf8'));
  conditionalJobs = Object.values(condState.jobs as Record<string, any>)
    .map((j: any) => ({
      jobId: j.jobId,
      provider: j.provider ? (ROLE_NAMES[j.provider] ?? j.provider) : null,
      asset: ASSET_NAMES[j.asset] ?? j.asset,
      window: j.window,
      op: OP_NAMES[j.op] ?? j.op,
      expected: j.expected ?? null,
      deadline: j.deadline,
      settled: j.settled,
      outcome: j.outcome ?? 'pending',
      realized: j.realized ?? null,
      amount: j.amount ?? null,
    }))
    .sort((a: any, b: any) => b.deadline - a.deadline);
} catch {
  // conditional_state.json not present yet — feature not active, empty list
  conditionalJobs = [];
}

const out = {
  providers, jobs, totalSlashes, totalJobs, totalEvents, latestSlash,
  conditionalJobs,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync('public/data.json', JSON.stringify(out, null, 2));
console.log(`wrote public/data.json: ${providers.length} providers, ${jobs.length} jobs shown (latest job #${totalJobs}), ${totalSlashes} slashes (latest: job#${latestSlash?.jobId}), ${conditionalJobs.length} conditional contracts`);
