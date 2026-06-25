/**
 * protocol/escrow.ts
 * Typed viem wrapper for ERC8183 core + BondHook
 * Covers the job lifecycle Althemis needs:
 *   createJob / setBudget / fund / submit / complete / reject / getJob
 * Plus bond helpers: deposit / withdraw / freeBalance / setProviderBondRate
 */
import 'dotenv/config';
import { parseAbi, encodeFunctionData, decodeEventLog, type Address, type Hex } from 'viem';
import { getPublicClient, getOracleClient, getOracleAddress, makeWalletClient } from './arc.js';

// ── Contract addresses (from .env) ────────────────────────────
export const ERC8183_ADDRESS  = process.env.ERC8183_ADDRESS  as Address;
export const BOND_HOOK_ADDRESS = process.env.BOND_HOOK_ADDRESS as Address;
export const USDC_ADDRESS     = process.env.USDC_ADDRESS     as Address;

// ── ERC8183 ABI (subset used by Althemis) ─────────────────────
export const ERC8183_ABI = parseAbi([
  // Core lifecycle
  'function createJob(address provider, address evaluator, uint48 expiredAt, string description, address hook, uint256 providerAgentId) returns (uint256)',
  'function setBudget(uint256 jobId, address token, uint256 amount, bytes optParams)',
  'function fund(uint256 jobId, uint256 expectedBudget, bytes optParams)',
  'function submit(uint256 jobId, bytes32 deliverable, bytes optParams)',
  'function complete(uint256 jobId, bytes32 reason, bytes optParams)',
  'function reject(uint256 jobId, bytes32 reason, bytes optParams)',
  'function claimRefund(uint256 jobId)',
  // Read
  // getJob uses JSON ABI (see GET_JOB_ABI below)
  'function jobCounter() view returns (uint256)',
  // Events
  'event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint48 expiredAt, address hook)',
  'event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount)',
  'event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable)',
  'event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason)',
  'event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason)',
]);

// ── BondHook ABI ─────────────────────────────────────────────
// Tier enum is gone — the oracle pushes the effective rate in basis points
// (reliability × skill discount, computed offchain in tier.ts).
export const BOND_HOOK_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function freeBalance(address provider) view returns (uint256)',
  'function bondBalance(address provider) view returns (uint256)',
  'function bondLocked(address provider) view returns (uint256)',
  'function setProviderBondRate(address provider, uint256 rateBps)',
  'function providerBondRateBps(address provider) view returns (uint256)',
  'function providerJobCount(address provider) view returns (uint256)',
  'function getBondRate(address provider) view returns (uint256)',
  'function DEFAULT_BOND_RATE_BPS() view returns (uint256)',
  'function MIN_BOND_RATE_BPS() view returns (uint256)',
  'function SLASH_REASON() view returns (bytes32)',
  'function challenge(uint256 jobId)',
  'function jobBondLocked(uint256 jobId) view returns (uint256)',
  'function jobBudget(uint256 jobId) view returns (uint256)',
  'event BondDeposited(address indexed provider, uint256 amount)',
  'event BondSlashed(uint256 indexed jobId, address indexed provider, uint256 amount, address consumer, address treasury)',
  'event BondRateUpdated(address indexed provider, uint256 newRateBps)',
  'event BondChallenged(uint256 indexed jobId, address indexed challenger, uint256 reward)',
  'event ChallengeRejected(uint256 indexed jobId, address indexed challenger, uint256 stakeForfeited)',
]);

// ── USDC ABI (approve + balanceOf) ───────────────────────────
const USDC_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

// ── JobStatus enum ────────────────────────────────────────────
export enum JobStatus {
  Open = 0, Funded = 1, Submitted = 2,
  Completed = 3, Rejected = 4, Expired = 5,
}

// ── Job type ──────────────────────────────────────────────────
export interface Job {
  jobId:        bigint;
  client:       Address;
  status:       JobStatus;
  provider:     Address;
  expiredAt:    number;
  evaluator:    Address;
  submittedAt:  number;
  budget:       bigint;
  hook:         Address;
  paymentToken: Address;
  description:  string;
}

// ── tx helper ───────────────────────────────────────────────────
/** Wait for a tx receipt and throw if it reverted. Shared by all write helpers below. */
async function waitForSuccess(hash: Hex, label: string) {
  const pub = getPublicClient();
  const rc = await pub.waitForTransactionReceipt({ hash });
  if (rc.status !== 'success') throw new Error(`${label} tx reverted: ${hash}`);
  return rc;
}

// ── Read helpers ──────────────────────────────────────────────

export async function getJob(jobId: bigint): Promise<Job> {
  const pub = getPublicClient();
  const raw = await pub.readContract({
    address: ERC8183_ADDRESS,
    abi: GET_JOB_ABI,
    functionName: 'getJob',
    args: [jobId],
  }) as any;

  return {
    jobId,
    client:       raw.client,
    status:       raw.status as JobStatus,
    provider:     raw.provider,
    expiredAt:    Number(raw.expiredAt),
    evaluator:    raw.evaluator,
    submittedAt:  Number(raw.submittedAt),
    budget:       raw.budget,
    hook:         raw.hook,
    paymentToken: raw.paymentToken,
    description:  raw.description,
  };
}

export async function getJobCounter(): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'jobCounter',
  }) as Promise<bigint>;
}

/** Fetch all Submitted jobs awaiting oracle evaluation */
export async function getSubmittedJobs(): Promise<Job[]> {
  const counter = await getJobCounter();
  const jobs: Job[] = [];
  // Batch read — for large counts, use event indexing instead
  for (let i = 1n; i <= counter; i++) {
    const job = await getJob(i);
    if (job.status === JobStatus.Submitted) jobs.push(job);
  }
  return jobs;
}

export async function getFreeBalance(provider: Address): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'freeBalance',
    args: [provider],
  }) as Promise<bigint>;
}

/** Current effective bond rate (basis points) onchain. Returns DEFAULT if unset. */
export async function getProviderBondRate(provider: Address): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'getBondRate',
    args: [provider],
  }) as Promise<bigint>;
}

export async function getSlashReason(): Promise<Hex> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'SLASH_REASON',
  }) as Promise<Hex>;
}

// ── Consumer-side helpers (job creation / funding) ────────────

/**
 * Consumer: create a new job. Waits for receipt, decodes JobCreated, returns jobId.
 * evaluator defaults to the oracle address; hook defaults to BondHook.
 */
export async function createJob(
  walletClient: ReturnType<typeof makeWalletClient>,
  params: {
    provider: Address;
    description: string;
    evaluator?: Address;
    hook?: Address;
    expiredAt?: number;        // unix seconds; default now + 24h
    providerAgentId?: bigint;  // default 0n
  },
): Promise<bigint> {
  const evaluator      = params.evaluator      ?? getOracleAddress();
  const hook           = params.hook           ?? BOND_HOOK_ADDRESS;
  const expiredAt      = params.expiredAt      ?? Math.floor(Date.now() / 1000) + 86400;
  const providerAgentId = params.providerAgentId ?? 0n;

  const hash = await walletClient.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'createJob',
    args: [params.provider, evaluator, expiredAt, params.description, hook, providerAgentId],
    chain: walletClient.chain!,
  });
  const rc = await waitForSuccess(hash, 'createJob');

  for (const log of rc.logs) {
    try {
      const ev = decodeEventLog({ abi: ERC8183_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === 'JobCreated') return ev.args.jobId as bigint;
    } catch {}
  }
  throw new Error(`JobCreated event not found in createJob receipt: ${hash}`);
}

/** Provider: set the budget (price) for a job. */
export async function setBudget(
  walletClient: ReturnType<typeof makeWalletClient>,
  jobId: bigint,
  amount: bigint,
  token: Address = USDC_ADDRESS,
): Promise<Hex> {
  const hash = await walletClient.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'setBudget',
    args: [jobId, token, amount, '0x'],
    chain: walletClient.chain!,
  });
  await waitForSuccess(hash, 'setBudget');
  return hash;
}

/** Consumer: approve USDC then fund the job. Two sequential txs, each awaited. */
export async function fundJob(
  walletClient: ReturnType<typeof makeWalletClient>,
  jobId: bigint,
  amount: bigint,
): Promise<Hex> {
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [ERC8183_ADDRESS, amount],
    chain: walletClient.chain!,
  });
  await waitForSuccess(approveHash, 'fundJob:approve');

  const fundHash = await walletClient.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'fund',
    args: [jobId, amount, '0x'],
    chain: walletClient.chain!,
  });
  await waitForSuccess(fundHash, 'fundJob:fund');
  return fundHash;
}

// ── Write helpers (oracle wallet) ─────────────────────────────

/** Oracle: mark job complete (price verified) */
export async function completeJob(jobId: bigint, reason: Hex): Promise<Hex> {
  const wallet = getOracleClient();
  return wallet.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'complete',
    args: [jobId, reason, '0x'],
    chain: wallet.chain!,
  });
}

/** Oracle: reject job (no-slash: prediction miss) */
export async function rejectJob(jobId: bigint, reason: Hex): Promise<Hex> {
  const wallet = getOracleClient();
  return wallet.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'reject',
    args: [jobId, reason, '0x'],
    chain: wallet.chain!,
  });
}

/** Oracle: reject job with SLASH_REASON (false attestation) */
export async function slashJob(jobId: bigint): Promise<Hex> {
  const slashReason = await getSlashReason();
  return rejectJob(jobId, slashReason);
}

/**
 * Oracle: push the effective bond rate (basis points) for a provider.
 * Computed offchain by tier.ts as reliability × skill_discount.
 * BondHook enforces rateBps >= MIN_BOND_RATE_BPS (10000 = 100%).
 */
export async function setProviderBondRate(
  provider: Address,
  rateBps: bigint,
): Promise<Hex> {
  const wallet = getOracleClient();
  return wallet.writeContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'setProviderBondRate',
    args: [provider, rateBps],
    chain: wallet.chain!,
  });
}

// ── Provider-side helpers (for examples/minimal-provider.ts) ──

/** Provider: deposit USDC bond (requires prior USDC approve). Waits for both txs. */
export async function depositBond(
  walletClient: ReturnType<typeof makeWalletClient>,
  amount: bigint,
): Promise<Hex> {
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [BOND_HOOK_ADDRESS, amount],
    chain: walletClient.chain!,
  });
  await waitForSuccess(approveHash, 'depositBond:approve');

  const depositHash = await walletClient.writeContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'deposit',
    args: [amount],
    chain: walletClient.chain!,
  });
  await waitForSuccess(depositHash, 'depositBond:deposit');
  return depositHash;
}

/** Provider: submit signal as deliverable hash. Waits for receipt. */
export async function submitSignal(
  walletClient: ReturnType<typeof makeWalletClient>,
  jobId: bigint,
  signalValue: string,   // e.g. "FR_BTC_8h=0.032%"
): Promise<Hex> {
  const { keccak256, toBytes } = await import('viem');
  const deliverable = keccak256(toBytes(signalValue));
  const hash = await walletClient.writeContract({
    address: ERC8183_ADDRESS,
    abi: ERC8183_ABI,
    functionName: 'submit',
    args: [jobId, deliverable, '0x'],
    chain: walletClient.chain!,
  });
  await waitForSuccess(hash, 'submitSignal');
  return hash;
}

// ── getJob JSON ABI (tuple不可のため分離) ────────────────────
export const GET_JOB_ABI = [{
  name: 'getJob',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'jobId', type: 'uint256' }],
  outputs: [{
    type: 'tuple',
    components: [
      { name: 'client',          type: 'address' },
      { name: 'status',          type: 'uint8'   },
      { name: 'provider',        type: 'address' },
      { name: 'expiredAt',       type: 'uint48'  },
      { name: 'evaluator',       type: 'address' },
      { name: 'submittedAt',     type: 'uint48'  },
      { name: 'budget',          type: 'uint256' },
      { name: 'hook',            type: 'address' },
      { name: 'paymentToken',    type: 'address' },
      { name: 'providerAgentId', type: 'uint256' },
      { name: 'description',     type: 'string'  },
    ],
  }],
}] as const;

// ── Challenger-side helpers (permissionless challenge) ─────────────
// BondHook.challenge() never reverts on a "wrong guess" — it either
// slashes (expired squatter / post-expiry submit) or forfeits the
// challenger's stake to treasury via ChallengeRejected. Safe to call
// speculatively; losses are bounded to budget/10 per miss.

/** Read whether a job currently has any bond locked (precondition for challenge to not revert on NotChallengeable). */
export async function getJobBondLocked(jobId: bigint): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'jobBondLocked',
    args: [jobId],
  }) as Promise<bigint>;
}

/** Read the budget recorded for a job (challenge basis: stake = budget/10). */
export async function getJobBudget(jobId: bigint): Promise<bigint> {
  const pub = getPublicClient();
  return pub.readContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'jobBudget',
    args: [jobId],
  }) as Promise<bigint>;
}

/**
 * Challenger: approve USDC stake then call challenge(jobId). Two sequential
 * txs, each awaited. stake = jobBudget(jobId) / 10n — caller must approve
 * exactly that amount (or read getJobBudget() first and compute it).
 */
export async function challengeJob(
  walletClient: ReturnType<typeof makeWalletClient>,
  jobId: bigint,
  stake: bigint,
): Promise<Hex> {
  const approveHash = await walletClient.writeContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: 'approve',
    args: [BOND_HOOK_ADDRESS, stake],
    chain: walletClient.chain!,
  });
  await waitForSuccess(approveHash, 'challengeJob:approve');

  const challengeHash = await walletClient.writeContract({
    address: BOND_HOOK_ADDRESS,
    abi: BOND_HOOK_ABI,
    functionName: 'challenge',
    args: [jobId],
    chain: walletClient.chain!,
  });
  await waitForSuccess(challengeHash, 'challengeJob:challenge');
  return challengeHash;
}

/**
 * Find jobs currently challengeable via BondHook.challenge().
 * Mirrors the on-chain predicate exactly (BondHook.sol:338-355) so this
 * never reports a false positive that would revert/forfeit on-chain:
 *   - jobBondLocked(jobId) > 0  (NotChallengeable guard)
 *   - expiredSquatter: status in {Funded, Submitted} AND now > expiredAt
 *   - postExpirySubmit: submittedAt > expiredAt (both nonzero)
 * Scans jobCounter linearly — fine at current scale, swap to event
 * indexing (JobFunded/JobSubmitted) if job volume grows materially.
 */
export async function getChallengeableJobs(): Promise<Job[]> {
  const counter = await getJobCounter();
  const candidates: Job[] = [];

  // Pass 1: cheap filter — only jobs with locked bond can possibly qualify.
  for (let i = 1n; i <= counter; i++) {
    const locked = await getJobBondLocked(i);
    if (locked === 0n) continue;
    const job = await getJob(i);
    candidates.push(job);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  return candidates.filter((job) => {
    const expiredSquatter =
      job.expiredAt !== 0 &&
      nowSec > job.expiredAt &&
      (job.status === JobStatus.Funded || job.status === JobStatus.Submitted);
    const postExpirySubmit =
      job.submittedAt !== 0 &&
      job.expiredAt   !== 0 &&
      job.submittedAt > job.expiredAt;
    return expiredSquatter || postExpirySubmit;
  });
}

// ── Memo-wrapped submit (PCONF commissioning provenance) ──────────
// Additive. The existing submitSignal() above is byte-for-byte untouched —
// PCHEAP/PHONEST/PLIAR/main.js keep using it. Only commission-server calls this.
// Inner calldata is IDENTICAL to submitSignal's submit(jobId, deliverable, '0x');
// the only difference is the outer Memo wrapper that emits provenance keyed by
// jobId. msg.sender to ERC8183 is preserved by the CallFrom precompile (EOA-only;
// PCONF is an EOA). See protocol/memo.ts.
export async function submitSignalWithMemo(
  walletClient: ReturnType<typeof makeWalletClient>,
  jobId: bigint,
  signalValue: string,
  memo: Record<string, unknown>,
): Promise<Hex> {
  const { keccak256, toBytes, toHex, stringToHex, encodeFunctionData } = await import('viem');
  const { MEMO_ADDRESS, MEMO_ABI } = await import('./memo.js');

  const deliverable = keccak256(toBytes(signalValue));
  // inner = exactly what submitSignal() sends to ERC8183
  const inner = encodeFunctionData({
    abi: ERC8183_ABI,
    functionName: 'submit',
    args: [jobId, deliverable, '0x'],
  });

  const memoId   = toHex(jobId, { size: 32 });                    // reversible → dashboard join key
  const memoData = stringToHex(JSON.stringify({ v: 1, ...memo })); // plaintext: caller must NOT pass raw CONF value

  const hash = await walletClient.writeContract({
    address: MEMO_ADDRESS,
    abi: MEMO_ABI,
    functionName: 'memo',
    args: [ERC8183_ADDRESS, inner, memoId, memoData],
    chain: walletClient.chain!,
  });
  await waitForSuccess(hash, 'submitSignalWithMemo');
  return hash;
}
