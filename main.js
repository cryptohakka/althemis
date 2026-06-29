import 'dotenv/config';
import { fetchAllSignals } from './providers.js';
import { runConsumerCycle } from './council.js';
import { parseUnits, parseAbi } from 'viem';
import { getPublicClient, loadRoster } from './protocol/arc.js';
import {
  USDC_ADDRESS,
  getJob, getFreeBalance, getProviderBondRate, JobStatus,
  createJob, setBudget, fundJob, submitSignal, depositBond,
  getChallengeableJobs, getJobBudget, challengeJob,
} from './protocol/escrow.js';
import { loadJobState, saveJobState } from './protocol/job-state.js';
import { getPolicy, getActiveProviders, getActiveRoles } from './protocol/roster.config.js';
import { tickConditional } from './protocol/conditional-provider.js';
import { processConditionalJobs } from './protocol/conditional.js';

const CYCLE_MS       = parseInt(process.env.CYCLE_INTERVAL_MS || '300000');
const SUBMIT_NEUTRAL = process.env.SUBMIT_NEUTRAL !== 'false'; // testnet default: true

// ── Rollout phase (operator-controlled checkpoint, NOT auto-detected) ──
// 1 = PCHEAP solo (drives verifiedCount -> Gold with zero other supply,
//     zero buyer favoritism — see roster.config.ts header).
// 2 = PHONEST/PLIAR also active. job-state Map already supports concurrent
//     per-role jobs (Step 3). Flip via .env ROLLOUT_PHASE=2 ONLY AFTER
//     confirming PCHEAP has actually reached Gold on-chain — this value is
//     read once at process startup, NOT live-reloaded. Changing it requires
//     systemctl restart althemis (see job-state.js incident — pair stop/start
//     in one script, never split across sessions).
// NOTE: XCHAL is listed as phase 2 in roster.config.ts but has NO tick logic
// here — escrow.ts has no permissionless-challenge TS wrapper yet (the
// Solidity side exists per contract-core completion, but the TS call site
// doesn't). XCHAL activation is a separate prerequisite task, not part of
// this step.
const ROLLOUT_PHASE = parseInt(process.env.ROLLOUT_PHASE || '1');

const USDC_ABI = parseAbi([
  'function decimals() view returns (uint8)',
]);

// ── viem clients — all 5 roster wallets built once at startup ──────────
const pub    = getPublicClient();
const roster = loadRoster(); // { PCHEAP, PHONEST, PLIAR, CBUYER, XCHAL }
const cbuyer = roster.CBUYER;

// ── Job state (Map<role, record>; shared format via protocol/job-state.js) ─
function persistJobState() { saveJobState(jobState); }
const jobState = loadJobState();

async function syncFromChain(stateMap) {
  // v2: each role holds an ARRAY of concurrent jobs. Re-check every job
  // individually on-chain; remove only the ones that hit a terminal status.
  // Active jobs for OTHER jobIds in the same role's array are untouched.
  for (const [role, jobs] of stateMap) {
    const kept = [];
    for (const record of jobs) {
      const job = await getJob(BigInt(record.jobId));
      const statusName = JobStatus[job.status];
      if (job.status === JobStatus.Completed ||
          job.status === JobStatus.Rejected  ||
          job.status === JobStatus.Expired) {
        console.log(`[job-state] ${role} job #${record.jobId} settled (${statusName}) — removing`);
        continue;
      }
      if (record.status !== statusName) {
        console.log(`[job-state] ${role} job #${record.jobId} status ${record.status ?? '?'} -> ${statusName}`);
        record.status = statusName;
      }
      kept.push(record);
    }
    if (kept.length === 0) stateMap.delete(role);
    else stateMap.set(role, kept);
  }
  persistJobState();
}

// Demo-proven fabrication payload — identical to fabricate.mjs's FAKE_DESC,
// already verified to trigger Phase A slash under the current threshold.
// Fixed (not randomized) so the dishonest path stays deterministic and
// reproducible for the demo, independent of real market conditions.
const FABRICATED_DESCRIPTION = 'FR_BTC_8h=0.005;z=99;dir=long';

// ── Generic per-provider tick ───────────────────────────────────────────
// One role, one job lifecycle: skip-if-active -> honesty roll -> bond
// check -> createJob(by CBUYER) -> setBudget(by provider) ->
// fundJob(by CBUYER) -> submitSignal(by provider).
async function tickProvider(role, frSig, dec) {
  // v2: skip-if-active gate REMOVED. A new job is submitted every cycle
  // regardless of how many of this role's prior jobs are still pending —
  // Phase A verification doesn't wait for the 8h Phase B / completeJob().
  // No concurrency cap: PCHEAP's sub-cent budget keeps bond/escrow exposure
  // negligible even with many jobs in flight simultaneously.
  const policy    = getPolicy(role);
  const agent     = roster[role];
  const fabricate = Math.random() < policy.fabricationProb;

  let description;
  if (fabricate) {
    description = FABRICATED_DESCRIPTION;
    console.log(`[provider-job] ${role} honesty roll: FABRICATE (p=${policy.fabricationProb})`);
  } else {
    if (frSig.direction === 'neutral' && !SUBMIT_NEUTRAL) {
      console.log(`[provider-job] ${role} neutral signal — skip (SUBMIT_NEUTRAL=false)`);
      return;
    }
    const frValue = parseFloat(frSig.avgFR.toFixed(8));
    description = `FR_BTC_8h=${frValue};z=${frSig.frZ};dir=${frSig.direction}`;
  }

  const budget = parseUnits(policy.budgetUSDC.toString(), dec);

  // Bond requirement scales with THIS role's budget and THIS role's
  // on-chain rate (bps) — not a flat constant. A fixed "2 USDC" assumed
  // budget=1 USDC @ 200%; that breaks the moment budgets differ per role
  // (PCHEAP sub-cent vs PHONEST/PLIAR standard).
  const rateBps    = await getProviderBondRate(agent.address);
  const bondNeeded = (budget * rateBps) / 10000n;
  const free       = await getFreeBalance(agent.address);
  if (free < bondNeeded) {
    console.log(`[provider-job] ${role} topping up bond (need ${bondNeeded}, have ${free})...`);
    await depositBond(agent.client, bondNeeded);
  }

  const jobId = await createJob(cbuyer.client, {
    provider: agent.address,
    description,
  });
  await setBudget(agent.client, jobId, budget);
  await fundJob(cbuyer.client, jobId, budget);
  await submitSignal(agent.client, jobId, description);

  const jobs = jobState.get(role) || [];
  jobs.push({
    jobId: jobId.toString(), description,
    submittedAt: new Date().toISOString(), status: 'Submitted',
    fabricated: fabricate,
  });
  jobState.set(role, jobs);
  persistJobState();
  console.log(`[provider-job] ${role} job #${jobId} submitted (${jobs.length} active for ${role}): ${description}`);
}

// ── Generic challenger tick ─────────────────────────────────────────────
// XCHAL sweeps BondHook for currently-challengeable jobs (expired squatter /
// post-expiry submit) and fires challenge() on each. Never reverts on a
// miss -- contract either slashes (success) or forfeits XCHAL's stake to
// treasury via ChallengeRejected (failure). Sequential per call: single
// XCHAL wallet, avoid self-inflicted nonce races across multiple candidates.
async function tickChallenger() {
  const candidates = await getChallengeableJobs();
  if (candidates.length === 0) {
    console.log('[challenger] no challengeable jobs this cycle');
    return;
  }
  for (const job of candidates) {
    let budget;
    try {
      budget = await getJobBudget(job.jobId);
    } catch (e) {
      console.log(`[challenger] job #${job.jobId} — budget unreadable (settled/stale), skip`);
      continue;
    }
    try {
      const stake = budget / 10n;
      console.log(`[challenger] XCHAL challenging job #${job.jobId} (stake=${stake})`);
      const hash = await challengeJob(roster.XCHAL.client, job.jobId, stake);
      console.log(`[challenger] job #${job.jobId} challenge tx=${hash}`);
    } catch (e) {
      console.error(`[challenger] job #${job.jobId} challenge failed: ${(e&&e.shortMessage)||(e&&e.message)||String(e)}`);
    }
  }
}

// ── Main cycle ───────────────────────────────────────────────────────────
let cycleInFlight = false;
async function runCycle() {
  if (cycleInFlight) {
    console.log('[main] previous cycle still running -- skip this tick');
    return;
  }
  cycleInFlight = true;
  console.log(`\n[main] cycle start ${new Date().toISOString()}`);
  try {
    const signals = await fetchAllSignals();
    const verdict = await runConsumerCycle(signals);
    console.log(`[main] done — action=${verdict.action} conf=${verdict.confidence} cal=${verdict.calibrated} DI=${verdict.disagreementIndex}`);

    if (!signals.fr.baselineReady) {
      console.log('[provider-job] FR baseline not ready — skip');
      return;
    }

    await syncFromChain(jobState);

    const dec = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'decimals' });
    const activeProviders = getActiveProviders(ROLLOUT_PHASE);

    // Sequential on purpose: every provider job is created/funded by the
    // SAME CBUYER wallet. Concurrent writeContract calls from one client
    // risk nonce collisions — process roles one at a time, not Promise.all.
    for (const { role } of activeProviders) {
      await tickProvider(role, signals.fr, dec);
    }

    // Conditional contract declaration — independent escrow, independent
    // wallet usage pattern (reuses CBUYER/PCHEAP), runs after the existing
    // provider ticks so a nonce issue here can never affect them.
    await tickConditional(roster, signals.fr, dec);
    // Conditional indexer + settle: read Declared/Purchased logs into state,
    // settle/withdraw matured jobs from public feed. Self-contained (no args).
    await processConditionalJobs();

    const activeRoles = getActiveRoles(ROLLOUT_PHASE);
    if (activeRoles.includes('XCHAL')) {
      await tickChallenger();
    }
  } catch (e) {
    console.error('[main] cycle error:', e.message);
  } finally {
    cycleInFlight = false;
  }
}

console.log(`[main] rollout phase=${ROLLOUT_PHASE} active providers=${getActiveProviders(ROLLOUT_PHASE).map(p => p.role).join(',')}`);
runCycle();
setInterval(runCycle, CYCLE_MS);
