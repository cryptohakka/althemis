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
    };
  })
  .sort((a, b) => b.verifiedCount - a.verifiedCount);

const RECENT_N = 200;
const recentEvents = events.slice(-RECENT_N).reverse();

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
const totalJobs = events.length;
const latestSlash = events.filter(e => e.outcome === 'slashed').slice(-1)[0] ?? null;

const out = {
  providers, jobs, totalSlashes, totalJobs, latestSlash,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync('public/data.json', JSON.stringify(out, null, 2));
console.log(`wrote public/data.json: ${providers.length} providers, ${jobs.length} jobs shown (of ${totalJobs} total events), ${totalSlashes} slashes (latest: job#${latestSlash?.jobId})`);
