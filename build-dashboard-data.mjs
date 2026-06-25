import fs from 'fs';

const ROLE_NAMES = {
  '0xbEc3bCcf463b62E456a062195a6708840C78a1Ab': 'PCHEAP',
  '0xBe57D502dD6Ac3824E6869555e50085d79453313': 'PHONEST',
  '0x1D58AF58145E56d508A448aEf65D5F2797aBe874': 'PLIAR',
  '0xF7e8ff5485330Ff4dBd69E807b66818Caa6085c7': 'PCONF',
};

const tiers = JSON.parse(fs.readFileSync('data/tiers.json', 'utf8'));
const oracleState = JSON.parse(fs.readFileSync('data/oracle_state.json', 'utf8'));
const events = fs.readFileSync('data/events.jsonl', 'utf8')
  .trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

const providers = Object.values(tiers)
  .filter(t => ROLE_NAMES[t.address])
  .map(t => ({
    name: ROLE_NAMES[t.address],
    address: t.address,
    reliabilityTier: t.reliabilityTier,
    verifiedCount: t.verifiedCount,
    skillTier: t.skillTier,
    cumWins: t.cumWins,
    cumLosses: t.cumLosses,
    bondRateBps: t.bondRateBps,
  }))
  .sort((a, b) => b.verifiedCount - a.verifiedCount);

const RECENT_N = 20;
const recentEvents = events.slice(-RECENT_N).reverse();
const jobs = recentEvents.map(e => {
  const st = oracleState[e.jobId];
  const providerAddr = st?.provider;
  return {
    jobId: e.jobId,
    ts: e.ts,
    phase: e.phase,
    outcome: e.outcome,
    detail: e.detail,
    tx: e.tx ?? null,
    provider: providerAddr ? (ROLE_NAMES[providerAddr] ?? providerAddr) : null,
  };
});

const totalSlashes = events.filter(e => e.outcome === 'slashed').length;
const totalJobs = events.length;
const latestSlash = events.filter(e => e.outcome === 'slashed').slice(-1)[0] ?? null;

const out = {
  providers, jobs, totalSlashes, totalJobs, latestSlash,
  generatedAt: new Date().toISOString(),
};
fs.writeFileSync('public/data.json', JSON.stringify(out, null, 2));
console.log(`wrote public/data.json: ${providers.length} providers, ${jobs.length} jobs shown (of ${totalJobs} total events), ${totalSlashes} slashes (latest: job#${latestSlash?.jobId})`);
